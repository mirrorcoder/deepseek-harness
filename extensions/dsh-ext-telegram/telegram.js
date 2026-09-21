// Minimal Telegram Bot API client with a serial, rate-limited outbox.
// `fetchImpl` is injectable so the whole thing is testable without a network.
import { TELEGRAM_MAX } from './format.js'

const API = 'https://api.telegram.org'

/**
 * One Bot API call without a client: what the management panel needs before a
 * destination exists (validating a token, listing chats, a test message).
 * @throws the API's own description, so the panel can show it verbatim.
 */
export async function callTelegram(token, method, payload = {}, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await response.json()
  if (body?.ok !== true) throw new Error(body?.description ?? `HTTP ${response.status}`)
  return body.result
}

export class TelegramClient {
  /**
   * @param {{token: string, chatId: string, minIntervalMs?: number,
   *          maxQueue?: number, fetchImpl?: typeof fetch, onError?: (e: Error) => void}} o
   */
  constructor(o) {
    this.token = o.token
    this.chatId = o.chatId
    this.minIntervalMs = o.minIntervalMs ?? 1200
    this.maxQueue = o.maxQueue ?? 200
    this.fetchImpl = o.fetchImpl ?? globalThis.fetch
    this.onError = o.onError ?? (() => {})
    this.queue = []
    /** The in-flight drain, so `drain()` can be awaited from anywhere. */
    this.running = undefined
    this.lastSentAt = 0
    this.dropped = 0
    this.sent = 0
  }

  async call(method, payload) {
    const response = await this.fetchImpl(`${API}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await response.json()
    if (body?.ok !== true) {
      const error = new Error(`telegram ${method} failed: ${body?.description ?? `HTTP ${response.status}`}`)
      error.code = body?.error_code
      throw error
    }
    return body.result
  }

  /** Create a topic (a thread) and return its id, or undefined when unsupported. */
  async createTopic(name) {
    try {
      const topic = await this.call('createForumTopic', { chat_id: this.chatId, name })
      return topic?.message_thread_id
    } catch (error) {
      this.onError(error)
      return undefined
    }
  }

  /** Enqueue one message; the outbox drains serially at the configured rate. */
  post(text, threadId) {
    if (this.queue.length >= this.maxQueue) {
      this.dropped++
      return
    }
    this.queue.push({ text: text.slice(0, TELEGRAM_MAX), threadId })
    void this.drain()
  }

  /**
   * Resolve once the outbox is empty. Folding into the in-flight run (instead
   * of returning early) is what lets a caller — a test, a shutdown — actually
   * wait for delivery rather than for the decision not to start a second loop.
   */
  async drain() {
    if (this.running === undefined) {
      this.running = this.loop().finally(() => { this.running = undefined })
    }
    await this.running
    // A post that landed while the loop was settling starts the next one.
    if (this.queue.length > 0) await this.drain()
  }

  async loop() {
    {
      while (this.queue.length > 0) {
        const wait = this.minIntervalMs - (Date.now() - this.lastSentAt)
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
        const item = this.queue.shift()
        this.lastSentAt = Date.now()
        try {
          await this.call('sendMessage', {
            chat_id: this.chatId,
            text: item.text,
            link_preview_options: { is_disabled: true },
            ...(item.threadId === undefined ? {} : { message_thread_id: item.threadId }),
          })
          this.sent++
        } catch (error) {
          // A thread that no longer exists must not wedge the outbox: report
          // once and keep draining the rest.
          this.onError(error)
        }
      }
    }
  }
}
