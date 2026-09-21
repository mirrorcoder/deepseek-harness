// dsh-ext-telegram — live broadcast of every session into Telegram, managed
// from inside the harness.
//
// One session becomes one topic (thread), named `project · subject` and
// coloured by project, so the thread list reads like the sidebar: the ask, what
// the agent answered, which tools it reached for, anything it is blocked on,
// and how long the run took, all inside that session's own thread.
//
// A private chat with the bot can hold topics ONLY after its owner turns
// Threaded Mode on in @BotFather; before that Telegram answers "the chat is not
// a forum" and this falls back to one flat conversation where every line
// carries its session's name. A forum supergroup works without that switch.
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
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { TelegramClient, callTelegram } from './telegram.js'
import { completionText, errorText, formatEvent, topicTitle } from './format.js'
import { envDestination, tokenRef } from './destinations.js'
import { createHandlers, dispatch } from './routes.js'
import { panelRows } from './panel.js'
import { UpdatePoller } from './poller.js'
import { Bindings, handleMessage } from './control.js'
import { topicSpec, topicName, workspaceOf } from './topics.js'
import { RunView } from './run-view.js'

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
  /** How often a streaming answer redraws its message; Telegram throttles edits. */
  editIntervalMs: z.number().default(1800),
})

const SETTINGS_NS = 'telegram'

/**
 * Fold a stored settings section over the plugin configuration.
 *
 * A plain spread is wrong here: a key the document does not mention can arrive
 * as an explicit `undefined`, and spreading that erases the schema default
 * behind it. That is how `commands` became undefined at boot and the bot went
 * on politely saying nothing to every `/start`.
 */
export function mergeSection(base, section) {
  const merged = { ...base }
  for (const [key, value] of Object.entries(section ?? {})) {
    if (value !== undefined) merged[key] = value
  }
  return merged
}
const SUMMARY_KINDS = new Set(['approval', 'title'])
const ROUTE_PREFIX = '/api/telegram/'

export function apply(ctx, initial) {
  let config = initial
  /** Last thing that went wrong, surfaced through the panel's state route. */
  let lastError

  const note = (error) => {
    lastError = error instanceof Error ? error.message : String(error)
    ctx.logger?.warn?.(`ext-telegram: ${lastError}`)
  }

  // The settings wiring is mounted at the END of this function on purpose: its
  // callback can run the moment it is registered, and everything it reaches for
  // (rebuild, the poller registry) is declared below. Mounting it here threw a
  // temporal-dead-zone ReferenceError at boot, which left the broadcast with no
  // destinations at all while the panel kept working — it calls Telegram
  // directly — so the bridge looked wired and silently was not.
  let scope

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
    syncPollers()
  }

  /** Registered workspaces, as both the control and the topic naming see them. */
  const listWorkspaces = () => {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) return []
    try {
      return registry.list().map((w) => ({ name: w.name, path: w.path, sessions: w.sessionIds?.length }))
    } catch {
      return []
    }
  }

  // ── the remote control ────────────────────────────────────────────────────
  /** `chatId:threadId` → session id, so a reply in a thread lands in its session. */
  const threadSessions = new Map()
  const bindings = new Bindings()

  const controlDeps = {
    bindings,
    // Lazy on purpose: `statusLine` is declared below, and naming it directly
    // here reads it during initialisation — the temporal-dead-zone crash that
    // took the whole harness down once already.
    status: () => statusLine(),
    sessions: async () => {
      const controller = ctx.get('sessionController')
      if (controller === undefined) throw new Error('session controller is not mounted')
      const answer = await controller.list({}, new AbortController().signal)
      return [...answer.items]
        .filter((item) => !item.blank)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 10)
    },
    workspaces: () => listWorkspaces(),
    workspaceOf,
    adopt: (chatId, threadId, sessionId) => adoptThread(chatId, threadId, sessionId),
    create: async (cwd) => {
      const controller = ctx.get('sessionController')
      if (controller === undefined) throw new Error('session controller is not mounted')
      const created = await controller.create(cwd === undefined ? {} : { cwd })
      return created.sessionId
    },
    prompt: async (sessionId, text, message) => {
      const controller = ctx.get('sessionController')
      if (controller === undefined) throw new Error('session controller is not mounted')
      // The thread this came from is where the session lives from now on, and
      // the harness will echo this very text back as a user message.
      if (message !== undefined) {
        threadSessions.set(`${message.chatId}:${message.threadId ?? ''}`, sessionId)
        adoptThread(message.chatId, message.threadId, sessionId)
      }
      rememberOwnPrompt(sessionId, text)
      await controller.prompt({
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, new AbortController().signal)
    },
    cancel: (sessionId) => {
      ctx.get('sessionController')?.cancel({ sessionId })
    },
  }

  // ── the bot answers ───────────────────────────────────────────────────────
  /** token → { poller, chats: Map<id, chat> } */
  const pollers = new Map()

  /** Chats a running listener has seen, newest first — what discover prefers. */
  const seenChats = (destinationId) => {
    for (const entry of pollers.values()) {
      if (entry.destinationId === destinationId) return [...entry.chats.values()].reverse()
    }
    return []
  }

  const statusLine = () => {
    if (targets.size === 0) return 'Пока ни один чат не подключён.'
    return [...targets.values()]
      .map((t) => `${t.destination.label || t.destination.id}: chat ${t.destination.chatId}, ${t.destination.mode === 'summary' ? 'только итоги' : 'полная лента'}`)
      .join('\n')
  }

  /**
   * One listener per destination, keyed by its credential reference rather
   * than by the token itself: at boot the credential store may not have loaded
   * yet, and a listener keyed by a token that did not resolve then would never
   * be created at all. The token is resolved inside each round instead, so a
   * store that arrives late simply makes the first round fail and the next one
   * succeed.
   */
  const syncPollers = () => {
    if (!config.commands) return
    try {
      const wanted = new Map()
      for (const target of targets.values()) {
        wanted.set(target.destination.id === 'env' ? 'TELEGRAM_BOT_TOKEN' : tokenRef(target.destination.id), target.destination.id)
      }
      for (const [ref, entry] of pollers) {
        if (!wanted.has(ref)) {
          entry.poller.stop()
          pollers.delete(ref)
        }
      }
      for (const [ref, destinationId] of wanted) {
        if (pollers.has(ref)) continue
        const chats = new Map()
        const poller = new UpdatePoller({
          api: async (method, payload) => {
            const token = await getToken(ref)
            if (token === undefined || token.length === 0) throw new Error('no token stored for this bot yet')
            return callTelegram(token, method, payload)
          },
          onChat: (chat) => {
            chats.delete(chat.id)
            chats.set(chat.id, { id: chat.id, title: chat.title, type: chat.type })
          },
          reply: (chatId, text, threadId) => {
            void (async () => {
              const token = await getToken(ref)
              if (token === undefined || token.length === 0) return
              await callTelegram(token, 'sendMessage', {
                chat_id: chatId,
                text,
                ...(threadId === undefined ? {} : { message_thread_id: threadId }),
              }).catch(note)
            })()
          },
          onMessage: async (chat) => {
            try {
              return await handleMessage({
                text: chat.text,
                chatId: chat.id,
                threadId: chat.threadId,
                threadSession: threadSessions.get(`${chat.id}:${chat.threadId ?? ''}`),
              }, { ...controlDeps, chat })
            } catch (error) {
              note(error)
              return `Не получилось: ${error instanceof Error ? error.message : String(error)}`
            }
          },
          onError: note,
          // A failure from the boot race (credentials not loaded yet) must not
          // sit in the panel forever once polling actually works.
          onOk: () => { lastError = undefined },
        })
        pollers.set(ref, { poller, chats, destinationId })
        void poller.run()
      }
    } catch (error) {
      // A silent rejection here is exactly how the bot ended up never polling.
      note(`could not start the update listener: ${error instanceof Error ? error.message : String(error)}`)
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
      note(`${target.destination.label || target.destination.id} has no token stored`)
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

  /**
   * `destination:sessionId` → thread the operator is already writing in. A
   * message that arrives in a thread makes that thread the session's home;
   * opening a second topic for the same session (as this did at first) splits
   * one conversation across two threads.
   */
  const adoptedThreads = new Map()

  const stateFor = (target, session) => {
    let state = target.sessions.get(session)
    if (state === undefined) {
      state = { threadId: undefined, opening: undefined, label: 'dsh session', announced: false }
      target.sessions.set(session, state)
    }
    if (state.threadId === undefined) {
      const adopted = adoptedThreads.get(`${target.destination.id}:${session.id}`)
      if (adopted !== undefined) state.threadId = adopted
    }
    return state
  }

  /** Remember where a session is being talked to, so output joins that thread. */
  const adoptThread = (chatId, threadId, sessionId) => {
    if (threadId === undefined || sessionId === undefined) return
    for (const target of targets.values()) {
      if (target.destination.chatId !== String(chatId)) continue
      adoptedThreads.set(`${target.destination.id}:${sessionId}`, threadId)
    }
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
  /** destination:sessionId → the live turn message being edited. */
  const runViews = new Map()
  const viewKey = (target, session) => `${target.destination.id}:${session.id}`

  /** Prompts this bridge sent, so the harness echoing them back is suppressed. */
  const ownPrompts = new Map()
  const rememberOwnPrompt = (sessionId, text) => {
    const key = `${sessionId}:${text.trim()}`
    ownPrompts.set(key, Date.now())
    // A fingerprint is only interesting until the harness commits the message.
    for (const [old, at] of ownPrompts) if (Date.now() - at > 60_000) ownPrompts.delete(old)
  }
  const isOwnPrompt = (sessionId, text) => {
    const key = `${sessionId}:${String(text).trim()}`
    if (!ownPrompts.has(key)) return false
    ownPrompts.delete(key)
    return true
  }

  /** The live turn message for one destination, opened on demand. */
  const viewFor = async (target, session) => {
    const key = viewKey(target, session)
    const existing = runViews.get(key)
    if (existing !== undefined) return existing
    const client = await clientFor(target)
    if (client === undefined) return undefined
    const threadId = await threadFor(target, client, session)
    const view = new RunView(client, threadId, { intervalMs: config.editIntervalMs })
    runViews.set(key, view)
    void view.open()
    return view
  }

  ctx.on('session/event', (session, event) => {
    if (targets.size === 0) return
    const data = event.data ?? {}
    for (const target of targets.values()) {
      const summary = target.destination.mode === 'summary'
      void (async () => {
        switch (event.type) {
          case 'user/message': {
            const line = formatEvent(event, { tools: target.destination.tools })
            if (line === undefined) return
            // What came from this bridge is already on screen as the operator's
            // own message; echoing it back is noise.
            if (isOwnPrompt(session.id, line.text.replace(/^👤\s*/, ''))) return
            if (summary) return
            const client = await clientFor(target)
            if (client === undefined) return
            client.post(line.text, await threadFor(target, client, session, line.text.replace(/^👤\s*/, '')))
            return
          }
          case 'assistant/message': {
            // The stream already wrote this; only fill in when no frames came.
            const view = runViews.get(viewKey(target, session))
            if (view === undefined || view.text.length > 0) return
            const line = formatEvent(event, { tools: target.destination.tools })
            if (line !== undefined) view.appendText(line.text.replace(/^🤖\s*/, ''))
            return
          }
          case 'tool/call': {
            if (summary || target.destination.tools === 'off') return
            const view = await viewFor(target, session)
            view?.setTool(data.name, argumentDigest(data.arguments))
            return
          }
          case 'approval/asked': {
            const client = await clientFor(target)
            if (client === undefined) return
            const line = formatEvent(event, { tools: target.destination.tools })
            if (line !== undefined) client.post(line.text, await threadFor(target, client, session))
            return
          }
          case 'session/title': {
            const state = stateFor(target, session)
            const named = topicName(state.workspace ?? workspaceOf(session.header?.cwd ?? session.cwd, listWorkspaces()), data.title)
            state.label = named
            const client = await clientFor(target)
            if (client !== undefined && state.threadId !== undefined) await client.renameTopic(state.threadId, named)
            return
          }
          default:
        }
      })()
    }
  })

  /** One-line digest of tool arguments for the status line. */
  const argumentDigest = (args) => {
    if (args === null || args === undefined) return undefined
    if (typeof args === 'string') return args.slice(0, 80)
    if (typeof args !== 'object') return String(args)
    for (const key of ['path', 'file_path', 'command', 'cmd', 'pattern', 'query', 'prompt', 'url']) {
      const value = args[key]
      if (typeof value === 'string' && value.length > 0) return value.replace(/\s+/g, ' ').slice(0, 80)
    }
    return undefined
  }

  /**
   * The thread a session speaks in: one the operator adopted, else one opened
   * for it, named and coloured by its project.
   */
  const threadFor = async (target, client, session, seed) => {
    const state = stateFor(target, session)
    if (state.threadId !== undefined) return state.threadId
    if (!target.topicsUsable) return undefined
    if (state.opening === undefined) {
      const spec = topicSpec({ cwd: session.header?.cwd ?? session.cwd, title: seed }, listWorkspaces())
      state.label = spec.name
      state.workspace = spec.workspace
      state.opening = client.createTopic(spec.name, spec.iconColor).then((id) => {
        state.threadId = id
        if (id === undefined) target.topicsUsable = false
        else {
          threadSessions.set(`${target.destination.chatId}:${id}`, session.id)
          adoptedThreads.set(`${target.destination.id}:${session.id}`, id)
        }
        return id
      })
    }
    return state.opening
  }

  // ── run boundaries ────────────────────────────────────────────────────────
  const runs = new WeakMap()
  const runUsage = new Map()
  const zeroUsage = () => ({ total: 0, cacheRead: 0, billedInput: 0 })

  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'running') {
      runs.set(agent, Date.now())
      runUsage.set(agent.session.id, zeroUsage())
      // Open the turn message immediately: the thread should show life before
      // the first token arrives.
      for (const target of targets.values()) {
        if (target.destination.mode === 'summary') continue
        void viewFor(target, agent.session)
      }
      return
    }
    const started = runs.get(agent)
    runs.delete(agent)
    const totals = runUsage.get(agent.session.id)
    runUsage.delete(agent.session.id)
    const elapsed = started === undefined ? 0 : Date.now() - started
    for (const target of targets.values()) {
      const key = viewKey(target, agent.session)
      const view = runViews.get(key)
      runViews.delete(key)
      if (view !== undefined) {
        void view.finish(completionText(elapsed, totals).replace(/^✅\s*/, '✅ '))
        continue
      }
      // Summary destinations keep the old one-line completion ping.
      if (started !== undefined && elapsed >= target.destination.minRunSeconds * 1000) {
        send(target, agent.session, completionText(elapsed, totals))
      }
    }
  })

  // The answer as it is written: frames carry raw deltas, which the turn
  // message absorbs. No frames (a provider without streaming) is fine — the
  // durable `assistant/message` fills the body instead.
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame?.type !== 'chunk' || targets.size === 0) return
    const chunk = frame.chunk
    if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string') return
    for (const target of targets.values()) {
      if (target.destination.mode === 'summary') continue
      const view = runViews.get(viewKey(target, agent.session))
      if (view !== undefined) view.appendText(chunk.text)
      else void viewFor(target, agent.session).then((opened) => opened?.appendText(chunk.text))
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
      runtime: () => ({
        live: targets.size,
        pollers: pollers.size,
        commands: config.commands === true,
        settingsLoaded: scope !== undefined,
        lastError: lastError ?? null,
      }),
      pollingState: (destinationId) => {
        if (!config.commands) return 'off'
        for (const entry of pollers.values()) {
          if (entry.destinationId !== destinationId) continue
          if (entry.poller.conflict) return 'conflict'
          return entry.poller.rounds > 0 ? 'listening' : 'starting'
        }
        return 'starting'
      },
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

  // ── settings: the durable list of destinations, applied live ──────────────
  ctx.inject(['settings'], (sctx) => {
    try {
      scope = sctx.settings.register(SETTINGS_NS, Config)
      sctx.effect(() => scope.watch(() => {
        config = mergeSection(config, scope.get())
        rebuild()
      }))
      config = mergeSection(config, scope.get())
      rebuild()
      ctx.logger?.info?.(`ext-telegram: ${targets.size} destination(s) live`)
    } catch (error) {
      // Boot failures here used to be invisible; the panel now shows them.
      note(`could not load destinations: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

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
