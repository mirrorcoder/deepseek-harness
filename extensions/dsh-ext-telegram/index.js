// dsh-ext-telegram — live broadcast of every session into Telegram, managed
// from inside the harness.
//
// One session becomes one topic (thread) in each configured chat, so the phone
// shows the same structure as the sidebar: the ask, what the agent answered,
// which tools it reached for, anything it is blocked on, and how long the run
// took. Telegram lets a bot open topics inside a private chat, so the target
// can be the operator's own chat with the bot; a forum supergroup behaves the
// same. A chat without topics falls back to plain prefixed messages.
//
// Bots are added from the page: the ✈ button opens a panel that talks to this
// extension's own routes, which sit inside the harness authentication fence.
// Tokens go to the credential store ($DSH_HOME/.credentials.yaml), never to
// settings, the session log or the browser; the panel only ever learns whether
// a token exists. Destinations live in settings.yaml under `telegram`, so they
// survive restarts and can also be edited by hand.
//
// Nothing here talks to the model, so a broadcast failure can never fail a
// turn: every outbox is serial, rate-limited, bounded, and reports rather than
// raises.
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { TelegramClient, callTelegram } from './telegram.js'
import { completionText, errorText, formatEvent, topicTitle } from './format.js'
import { envDestination, tokenRef } from './destinations.js'
import { createHandlers, dispatch } from './routes.js'
import { panelRows } from './panel.js'
import { UpdatePoller } from './poller.js'

export const name = 'ext-telegram'

const Destination = z.object({
  id: z.string().required(),
  label: z.string().default(''),
  chatId: z.string().default(''),
  mode: z.union(['stream', 'summary']).default('stream'),
  tools: z.union(['compact', 'off']).default('compact'),
  topics: z.boolean().default(true),
  enabled: z.boolean().default(true),
  minRunSeconds: z.number().default(45),
})

export const Config = z.object({
  /** Destinations; the panel writes these, and they can be edited by hand. */
  destinations: z.array(Destination).default([]),
  /** Show the ✈ button and serve its routes. */
  panel: z.boolean().default(true),
  /**
   * Let the bot answer `/start`, `/id`, `/status` and `/help`. Telegram allows
   * one update consumer per token, so turn this off if the same bot is already
   * polled by another process.
   */
  commands: z.boolean().default(true),
  /** Minimum gap between messages to one chat; Telegram throttles past roughly one per second. */
  minIntervalMs: z.number().default(1200),
  /** Outbox bound per destination. */
  maxQueue: z.number().default(200),
})

const SETTINGS_NS = 'telegram'
const SUMMARY_KINDS = new Set(['approval', 'title'])
const ROUTE_PREFIX = '/api/telegram/'

export function apply(ctx, initial) {
  let config = initial

  // ── settings: the durable list of destinations ────────────────────────────
  let scope
  ctx.inject(['settings'], (sctx) => {
    scope = sctx.settings.register(SETTINGS_NS, Config)
    sctx.effect(() => scope.watch(() => {
      config = { ...config, ...scope.get() }
      rebuild()
    }))
    config = { ...config, ...scope.get() }
    rebuild()
  })

  const readDestinations = async () => (scope?.get()?.destinations ?? config.destinations ?? [])
  const writeDestinations = async (list) => {
    if (scope === undefined) throw new Error('settings are not available in this composition')
    await scope.update({ destinations: list })
    config = { ...config, ...scope.get() }
    rebuild()
  }

  // ── credentials: one token per destination, never leaving the host ────────
  const getToken = async (ref) => {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) return process.env[ref]
    const resolved = await credentials.resolve(credentialRef(ref))
    return resolved?.value ?? process.env[ref]
  }
  const setToken = async (ref, value) => {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) throw new Error('no credential store is mounted, so a token cannot be saved')
    await credentials.set(credentialRef(ref), value)
  }
  const clearToken = async (ref) => {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) return
    await credentials.unset(credentialRef(ref)).catch(() => {})
  }

  // ── live broadcasters, rebuilt whenever the configuration moves ───────────
  /** id → { destination, client, token, sessions } */
  let targets = new Map()

  const rebuild = () => {
    const wanted = [...(config.destinations ?? [])]
    const fromEnv = envDestination(process.env)
    if (fromEnv !== undefined) wanted.unshift(fromEnv)
    const next = new Map()
    for (const destination of wanted) {
      if (!destination.enabled) continue
      const previous = targets.get(destination.id)
      next.set(destination.id, previous !== undefined && previous.destination.chatId === destination.chatId
        ? { ...previous, destination }
        : { destination, client: undefined, sessions: new WeakMap(), topicsUsable: destination.topics })
    }
    targets = next
    void syncPollers()
  }

  // ── the bot answers ───────────────────────────────────────────────────────
  /** token → { poller, chats: Map<id, chat> } */
  const pollers = new Map()

  /** Chats a running poller has seen, newest first — what discover prefers. */
  const seenChats = (token) => [...(pollers.get(token)?.chats.values() ?? [])].reverse()

  const statusLine = () => {
    if (targets.size === 0) return 'Пока ни один чат не подключён.'
    return [...targets.values()]
      .map((t) => `${t.destination.label || t.destination.id}: chat ${t.destination.chatId}, ${t.destination.mode === 'summary' ? 'только итоги' : 'полная лента'}`)
      .join('\n')
  }

  /** Start a poller for every token that wants one; stop the rest. */
  const syncPollers = async () => {
    if (!config.commands) return
    const wanted = new Map()
    for (const target of targets.values()) {
      const ref = target.destination.id === 'env' ? 'TELEGRAM_BOT_TOKEN' : tokenRef(target.destination.id)
      const token = await getToken(ref)
      if (token !== undefined && token.length > 0) wanted.set(token, true)
    }
    for (const [token, entry] of pollers) {
      if (!wanted.has(token)) {
        entry.poller.stop()
        pollers.delete(token)
      }
    }
    for (const token of wanted.keys()) {
      if (pollers.has(token)) continue
      const chats = new Map()
      const poller = new UpdatePoller({
        api: (method, payload) => callTelegram(token, method, payload),
        onChat: (chat) => {
          chats.delete(chat.id)
          chats.set(chat.id, { id: chat.id, title: chat.title, type: chat.type })
        },
        reply: (chatId, text, threadId) => {
          void callTelegram(token, 'sendMessage', {
            chat_id: chatId,
            text,
            ...(threadId === undefined ? {} : { message_thread_id: threadId }),
          }).catch((error) => ctx.logger?.warn?.(`ext-telegram: reply failed: ${error.message}`))
        },
        facts: (chatId) => ({
          chatId,
          configured: [...targets.values()].some((t) => t.destination.chatId === chatId),
          status: statusLine(),
        }),
        onError: (error) => ctx.logger?.warn?.(`ext-telegram: ${error.message}`),
      })
      pollers.set(token, { poller, chats })
      void poller.run()
    }
  }

  ctx.effect(() => () => {
    for (const entry of pollers.values()) entry.poller.stop()
    pollers.clear()
  }, 'ext-telegram: update pollers')

  const clientFor = async (target) => {
    if (target.client !== undefined) return target.client
    const ref = target.destination.id === 'env' ? 'TELEGRAM_BOT_TOKEN' : tokenRef(target.destination.id)
    const token = await getToken(ref)
    if (token === undefined || token.length === 0) {
      ctx.logger?.warn?.(`ext-telegram: ${target.destination.label || target.destination.id} has no token stored`)
      return undefined
    }
    target.client = new TelegramClient({
      token,
      chatId: target.destination.chatId,
      minIntervalMs: config.minIntervalMs,
      maxQueue: config.maxQueue,
      onError: (error) => {
        if (target.topicsUsable && /thread|topic|forum/i.test(error.message)) {
          target.topicsUsable = false
          ctx.logger?.warn?.(`ext-telegram: topics unavailable in chat ${target.destination.chatId}, falling back to plain messages`)
          return
        }
        ctx.logger?.warn?.(`ext-telegram: ${error.message}`)
      },
    })
    return target.client
  }

  const stateFor = (target, session) => {
    let state = target.sessions.get(session)
    if (state === undefined) {
      state = { threadId: undefined, opening: undefined, label: 'dsh session', announced: false }
      target.sessions.set(session, state)
    }
    return state
  }

  /** Post one line to a single destination, opening its thread on first use. */
  const send = (target, session, text, seed) => {
    void (async () => {
      const client = await clientFor(target)
      if (client !== undefined) broadcastTo(target, client, session, text, seed)
    })()
  }

  /** Post one line to every enabled destination that wants this kind. */
  const broadcast = (session, text, kind, seed) => {
    for (const target of targets.values()) {
      if (kind !== undefined && target.destination.mode === 'summary' && !SUMMARY_KINDS.has(kind)) continue
      send(target, session, text, seed)
    }
  }

  // ── the conversation ──────────────────────────────────────────────────────
  ctx.on('session/event', (session, event) => {
    if (targets.size === 0) return
    // Tool verbosity is per destination, so ask for the richest form and let
    // each destination drop what it does not want.
    const line = formatEvent(event, { tools: 'compact' })
    if (line === undefined) return
    for (const target of targets.values()) {
      if (line.kind === 'tool' && target.destination.tools === 'off') continue
      if (target.destination.mode === 'summary' && !SUMMARY_KINDS.has(line.kind)) continue
      if (line.kind === 'title') stateFor(target, session).label = topicTitle(event.data.title)
      send(target, session, line.text, line.kind === 'user' ? line.text.replace(/^👤\s*/, '') : undefined)
    }
  })

  /** The per-target half of `send`, once a client is known. */
  const broadcastTo = (target, client, session, text, seed) => {
    const state = stateFor(target, session)
    if (!target.topicsUsable) {
      client.post(state.announced ? text : `[${state.label}]\n${text}`)
      state.announced = true
      return
    }
    if (state.threadId === undefined && state.opening === undefined) {
      state.label = topicTitle(seed ?? state.label)
      state.opening = client.createTopic(state.label).then((id) => {
        state.threadId = id
        if (id === undefined) target.topicsUsable = false
      })
    }
    void Promise.resolve(state.opening).then(() => client.post(text, state.threadId))
  }

  // ── run boundaries ────────────────────────────────────────────────────────
  const runs = new WeakMap()
  const runUsage = new Map()
  const zeroUsage = () => ({ total: 0, cacheRead: 0, billedInput: 0 })

  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'running') {
      runs.set(agent, Date.now())
      runUsage.set(agent.session.id, zeroUsage())
      return
    }
    const started = runs.get(agent)
    runs.delete(agent)
    const totals = runUsage.get(agent.session.id)
    runUsage.delete(agent.session.id)
    if (started === undefined || targets.size === 0) return
    const elapsed = Date.now() - started
    for (const target of targets.values()) {
      if (elapsed < target.destination.minRunSeconds * 1000) continue
      send(target, agent.session, completionText(elapsed, totals))
    }
  })

  ctx.on('agent/error', ({ agent, error }) => {
    broadcast(agent.session, errorText(error), 'approval')
  })

  ctx.on('llm/stream', (options, next) => (async function* () {
    for await (const chunk of next()) {
      if (chunk.type === 'usage' && options.sessionId !== undefined) {
        const totals = runUsage.get(options.sessionId)
        if (totals !== undefined) {
          const input = chunk.usage.inputTokens ?? 0
          const cacheRead = chunk.usage.cacheReadTokens ?? 0
          const cacheWrite = chunk.usage.cacheWriteTokens ?? 0
          totals.billedInput += input + cacheRead + cacheWrite
          totals.cacheRead += cacheRead
          totals.total += input + cacheRead + cacheWrite + (chunk.usage.outputTokens ?? 0)
        }
      }
      yield chunk
    }
  })())

  // ── the panel: routes inside the authentication fence, plus its markup ────
  if (config.panel) {
    const handlers = createHandlers({
      list: readDestinations,
      save: writeDestinations,
      getToken,
      setToken,
      clearToken,
      api: (token, method, payload) => callTelegram(token, method, payload),
      seenChats,
      envDestination: () => envDestination(process.env),
      reload: rebuild,
    })

    // Fetch routes are EXACT paths — a wildcard matches nothing — so each
    // action is its own registration.
    ctx.inject(['connection'], (cctx) => {
      for (const action of Object.keys(handlers)) {
        cctx.effect(() => cctx.connection.fetch.register({
          path: `${ROUTE_PREFIX}${action}`,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            let body = {}
            try {
              body = await request.json()
            } catch {
              body = {}
            }
            return dispatch(handlers, action, body)
          },
        }), `ext-telegram: ${ROUTE_PREFIX}${action}`)
      }
    })

    ctx.inject(['webServer'], (wctx) => {
      const rows = panelRows()
      wctx.on('webserver/index-inject', (table) => {
        for (const row of rows) table.push(row)
      })
    })
  }

  // ── /tg: check the wiring from inside a session ───────────────────────────
  ctx.inject(['commands'], (cctx) => {
    cctx.effect(() => cctx.commands.register({
      name: 'tg',
      description: 'Send a test line to every Telegram destination and report their state',
      recordInput: false,
      handler: ({ agent }) => {
        if (targets.size === 0) {
          return { kind: 'success', text: 'Ни одного включённого бота. Открой панель ✈ справа внизу и добавь.' }
        }
        broadcast(agent.session, '🔔 Проверка связи из dsh')
        const conflicted = [...pollers.values()].filter((e) => e.poller.conflict).length
        const lines = [...targets.values()].map((t) => {
          const client = t.client
          return `${t.destination.label || t.destination.id}: chat ${t.destination.chatId}, ${t.destination.mode}, треды ${t.topicsUsable ? 'да' : 'нет'}`
            + (client === undefined ? ', ещё не отправлял' : `, отправлено ${client.sent}, в очереди ${client.queue.length}, потеряно ${client.dropped}`)
        })
        if (config.commands) {
          lines.push(conflicted > 0
            ? `Команды бота: ${conflicted} бот(а) уже опрашивает другой процесс, ответов не будет`
            : `Команды бота: слушаю (${pollers.size})`)
        }
        return { kind: 'success', text: lines.join('\n') }
      },
    }))
  })
}
