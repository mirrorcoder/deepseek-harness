// The panel's backend: small JSON handlers behind the harness's own
// authentication fence. Dependencies are injected, so every branch is testable
// without a network, a browser or a running harness.
import { chatsFromUpdates, normalize, redact, remove, slugify, tokenRef, upsert } from './destinations.js'

const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
const fail = (message, status = 400) => json({ ok: false, error: message }, status)

/**
 * @param {{
 *   list: () => Promise<object[]>, save: (list: object[]) => Promise<void>,
 *   getToken: (ref: string) => Promise<string | undefined>,
 *   setToken: (ref: string, value: string) => Promise<void>,
 *   clearToken: (ref: string) => Promise<void>,
 *   api: (token: string, method: string, payload?: object) => Promise<any>,
 *   envDestination?: () => object | undefined,
 *   reload: () => void,
 * }} deps
 */
export function createHandlers(deps) {
  const withToken = async (id) => {
    const token = await deps.getToken(tokenRef(id))
    if (token === undefined || token.length === 0) throw new Error('this bot has no token stored')
    return token
  }

  return {
    /**
     * Every topic this bridge has opened, with what the session behind it is.
     * Telegram cannot list a private chat's topics, so this list is the only
     * inventory there is — and the only way to clean up after a test run.
     */
    async threads() {
      if (deps.threads === undefined) return json({ threads: [] })
      return json({ threads: await deps.threads() })
    },

    /** Delete one topic and forget it. */
    async closeThread(body) {
      if (deps.closeThread === undefined) throw new Error('this build cannot close topics')
      const chatId = String(body?.chatId ?? '')
      const threadId = Number(body?.threadId)
      if (chatId.length === 0 || !Number.isInteger(threadId)) throw new Error('chatId and threadId are required')
      return json(await deps.closeThread(chatId, threadId))
    },

    /** Everything the panel renders, tokens reduced to a yes/no. */
    async state() {
      const list = await deps.list()
      const rows = await Promise.all(list.map(async (d) => {
        const token = await deps.getToken(tokenRef(d.id))
        return redact(d, {
          hasToken: (token ?? '').length > 0,
          // Whether the bot can answer here, which is what a silent /start is about.
          listening: (token ?? '').length === 0 ? 'no-token' : (deps.pollingState?.(d.id) ?? 'off'),
        })
      }))
      const env = deps.envDestination?.()
      return json({
        ok: true,
        destinations: env === undefined ? rows : [redact(env, { hasToken: true, readOnly: true }), ...rows],
        // What the process is actually doing right now. This deployment has no
        // logger, so without it a broadcast that quietly wired nothing looks
        // identical to one that works.
        runtime: deps.runtime?.() ?? {},
      })
    },

    /** Check a token before storing it, and report who it belongs to. */
    async validate(body) {
      const token = String(body.token ?? '').trim()
      if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) return fail('that does not look like a bot token (expected 123456:AA…)')
      try {
        const me = await deps.api(token, 'getMe')
        return json({ ok: true, username: me.username, name: me.first_name })
      } catch (error) {
        return fail(`Telegram rejected the token: ${error.message}`)
      }
    },

    /** Create or update one destination; the token is optional on update. */
    async save(body) {
      const list = await deps.list()
      const existing = list.find((d) => d.id === body.id)
      if (body.id !== undefined && existing === undefined) return fail('no such bot', 404)
      let record
      try {
        record = normalize(body, existing ?? {})
      } catch (error) {
        return fail(error.message)
      }
      record.id = existing?.id ?? slugify(record.label, list.map((d) => d.id))
      const token = String(body.token ?? '').trim()
      if (token.length > 0) {
        try {
          await deps.api(token, 'getMe')
        } catch (error) {
          return fail(`Telegram rejected the token: ${error.message}`)
        }
        await deps.setToken(tokenRef(record.id), token)
      } else if (existing === undefined) {
        return fail('a bot token is required to add a bot')
      }
      await deps.save(upsert(list, record))
      deps.reload()
      return json({ ok: true, destination: redact(record, { hasToken: true }) })
    },

    /**
     * Chats that have written to this bot; a bot cannot open a chat itself.
     * Accepts a raw token so the add form can look before anything is saved —
     * the chat id is required to save, so demanding a saved bot first would
     * close the circle.
     */
    async discover(body) {
      const raw = String(body.token ?? '').trim()
      let token
      if (raw.length > 0) {
        if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(raw)) return fail('that does not look like a bot token (expected 123456:AA…)')
        token = raw
      } else {
        const list = await deps.list()
        const id = String(body.id ?? '')
        if (!list.some((d) => d.id === id)) return fail('no such bot', 404)
        token = await withToken(id)
      }
      // A running listener is the bot's only `getUpdates` consumer — asking
      // Telegram again would answer with the nothing it already handed over —
      // so what it has seen is the authoritative list while it runs. A token
      // typed into the add form has no listener, so that path still asks.
      const cached = raw.length > 0 ? [] : (deps.seenChats?.(String(body.id ?? '')) ?? [])
      if (cached.length > 0) return json({ ok: true, chats: cached })
      try {
        const updates = await deps.api(token, 'getUpdates', { limit: 100, timeout: 0 })
        const chats = chatsFromUpdates(updates)
        return json({
          ok: true,
          chats,
          hint: chats.length === 0
            ? 'Напиши боту /start в Telegram (или добавь его в группу) и нажми ещё раз — бот не может написать первым.'
            : undefined,
        })
      } catch (error) {
        return fail(error.message)
      }
    },

    /** Deliver one line, so the operator sees the wiring work. */
    async test(body) {
      const list = await deps.list()
      const record = list.find((d) => d.id === String(body.id ?? ''))
      if (record === undefined) return fail('no such bot', 404)
      try {
        await deps.api(await withToken(record.id), 'sendMessage', {
          chat_id: record.chatId,
          text: 'dsh broadcast is wired',
          link_preview_options: { is_disabled: true },
        })
        return json({ ok: true })
      } catch (error) {
        return fail(error.message)
      }
    },

    /** Forget a destination and its token. */
    async remove(body) {
      const id = String(body.id ?? '')
      const list = await deps.list()
      if (!list.some((d) => d.id === id)) return fail('no such bot', 404)
      await deps.save(remove(list, id))
      await deps.clearToken(tokenRef(id))
      deps.reload()
      return json({ ok: true })
    },
  }
}

/** Route one request to its handler; unknown paths are a 404 by omission. */
export async function dispatch(handlers, action, body) {
  const handler = handlers[action]
  if (handler === undefined) return fail('unknown action', 404)
  try {
    return await handler(body ?? {})
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error), 500)
  }
}
