// dsh-ext-telegram — live broadcast of every session into Telegram.
//
// One session becomes one topic (thread) in the configured chat, so the phone
// shows the same structure as the sidebar: the ask, what the agent answered,
// which tools it reached for, anything it is blocked on, and how long the run
// took. Telegram lets a bot open topics in a private chat, so the target can be
// the operator's own chat with the bot; a forum supergroup works the same way.
// If topics are refused (an ordinary group, an old client), the extension falls
// back to plain messages prefixed with the session title and says so once.
//
// Nothing here talks to the model, so a broadcast failure can never fail a
// turn: the outbox is fire-and-forget, rate-limited and bounded.
import z from '@deepseek-ai/schemastery'
import { TelegramClient } from './telegram.js'
import { completionText, errorText, formatEvent, topicTitle } from './format.js'

export const name = 'ext-telegram'

export const Config = z.object({
  enabled: z.boolean().default(false),
  /** Credential reference (environment variable) holding the bot token. */
  tokenEnv: z.string().role('credential-ref').default('TELEGRAM_BOT_TOKEN'),
  /** Target chat: the operator's own chat with the bot, or a supergroup id. */
  chatId: z.string().default(''),
  /** `stream` posts the conversation live; `summary` posts only completions, approvals and errors. */
  mode: z.union(['stream', 'summary']).default('stream'),
  /** Tool calls in the stream: `compact` is one line each, `off` posts none. */
  tools: z.union(['compact', 'off']).default('compact'),
  /** One topic per session when the chat supports it. */
  topics: z.boolean().default(true),
  /** Runs shorter than this are not worth a completion ping. */
  minRunSeconds: z.number().default(45),
  /** Minimum gap between messages; Telegram throttles a chat past roughly one per second. */
  minIntervalMs: z.number().default(1200),
  /** Outbox bound; past it the oldest are dropped rather than growing without limit. */
  maxQueue: z.number().default(200),
})

const SUMMARY_KINDS = new Set(['approval', 'title'])

export function apply(ctx, config) {
  if (!config.enabled) return

  const token = process.env[config.tokenEnv] ?? ''
  if (token.length === 0 || config.chatId.length === 0) {
    ctx.logger?.warn?.(`ext-telegram: disabled — set ${config.tokenEnv} and chatId (see deploy/telegram.sh)`)
    return
  }

  let topicsUsable = config.topics
  const client = new TelegramClient({
    token,
    chatId: config.chatId,
    minIntervalMs: config.minIntervalMs,
    maxQueue: config.maxQueue,
    onError: (error) => {
      if (topicsUsable && /thread|topic|forum/i.test(error.message)) {
        topicsUsable = false
        ctx.logger?.warn?.(`ext-telegram: topics unavailable in this chat, falling back to plain messages (${error.message})`)
        return
      }
      ctx.logger?.warn?.(`ext-telegram: ${error.message}`)
    },
  })

  /** Per-session broadcast state: the thread, its label, and the open run. */
  const sessions = new WeakMap()
  const stateFor = (session) => {
    let state = sessions.get(session)
    if (state === undefined) {
      state = { threadId: undefined, opening: undefined, label: 'dsh session', announced: false }
      sessions.set(session, state)
    }
    return state
  }

  /** Post into the session's thread, opening it on first use. */
  const post = (session, text, seed) => {
    const state = stateFor(session)
    if (!topicsUsable) {
      client.post(state.announced ? text : `[${state.label}]\n${text}`)
      state.announced = true
      return
    }
    if (state.threadId !== undefined) {
      client.post(text, state.threadId)
      return
    }
    if (state.opening === undefined) {
      state.label = topicTitle(seed ?? state.label)
      state.opening = client.createTopic(state.label).then((id) => {
        state.threadId = id
        if (id === undefined) topicsUsable = false
      })
    }
    void state.opening.then(() => {
      client.post(text, state.threadId)
    })
  }

  // ── the conversation ──────────────────────────────────────────────────────
  ctx.on('session/event', (session, event) => {
    const line = formatEvent(event, { tools: config.tools })
    if (line === undefined) return
    if (config.mode === 'summary' && !SUMMARY_KINDS.has(line.kind)) return
    if (line.kind === 'title') {
      const state = stateFor(session)
      state.label = topicTitle(event.data.title)
    }
    post(session, line.text, line.kind === 'user' ? line.text.replace(/^👤\s*/, '') : undefined)
  })

  // ── run boundaries ────────────────────────────────────────────────────────
  const runs = new WeakMap()
  // What this run reported, keyed by session id (the only identity a model
  // request carries). The meter owns the authoritative view; this is just the
  // number the completion line quotes.
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
    if (started === undefined) return
    const elapsed = Date.now() - started
    if (elapsed < config.minRunSeconds * 1000) return
    post(agent.session, completionText(elapsed, totals))
  })

  ctx.on('agent/error', ({ agent, error }) => {
    post(agent.session, errorText(error))
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

  // ── /tg: test the wiring from inside a session ────────────────────────────
  ctx.inject(['commands'], (cctx) => {
    cctx.effect(() => cctx.commands.register({
      name: 'tg',
      description: 'Send a test line to the Telegram broadcast and report the outbox state',
      recordInput: false,
      handler: ({ agent }) => {
        post(agent.session, '🔔 Проверка связи из dsh')
        return {
          kind: 'success',
          text: [
            `Telegram broadcast: ${config.mode}, tools ${config.tools}, topics ${topicsUsable ? 'on' : 'off (fallback)'}`,
            `chat ${config.chatId} · sent ${client.sent} · queued ${client.queue.length} · dropped ${client.dropped}`,
          ].join('\n'),
        }
      },
    }))
  })
}
