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

/**
 * Fetch one Telegram file as bytes: `getFile` gives a path, the file endpoint
 * gives the content. This is how a photo sent to the bot reaches a model.
 * @returns {Promise<{data: Buffer, mediaType: string}>}
 */
export async function downloadFile(token, fileId, fetchImpl = globalThis.fetch) {
  const file = await callTelegram(token, 'getFile', { file_id: fileId }, fetchImpl)
  const path = file?.file_path
  if (typeof path !== 'string' || path.length === 0) throw new Error('Telegram returned no path for this file')
  const response = await fetchImpl(`${API}/file/bot${token}/${path}`)
  if (!response.ok) throw new Error(`file download failed: HTTP ${response.status}`)
  const data = Buffer.from(await response.arrayBuffer())
  const extension = path.split('.').pop()?.toLowerCase()
  const mediaType = extension === 'png'
    ? 'image/png'
    : extension === 'webp'
      ? 'image/webp'
      : extension === 'gif' ? 'image/gif' : 'image/jpeg'
  return { data, mediaType }
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
    this.edited = 0
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

  /**
   * Create a topic (a thread) and return its id, or undefined when this chat
   * cannot hold topics. A private chat can, but only once the bot's owner
   * turns Threaded Mode on in @BotFather; before that Telegram answers
   * "the chat is not a forum".
   */
  async createTopic(name, iconColor) {
    try {
      const topic = await this.call('createForumTopic', {
        chat_id: this.chatId,
        name,
        ...(iconColor === undefined ? {} : { icon_color: iconColor }),
      })
      return topic?.message_thread_id
    } catch (error) {
      this.onError(error)
      return undefined
    }
  }

  /** Stop the spinner on a tapped button; a failure here is cosmetic. */
  async answerCallback(callbackId, text) {
    try {
      await this.call('answerCallbackQuery', { callback_query_id: callbackId, ...(text === undefined ? {} : { text }) })
    } catch (error) {
      this.onError(error)
    }
  }

  /** Rename a topic once the session earns a real title; failures are cosmetic. */
  async renameTopic(threadId, name) {
    if (threadId === undefined) return
    try {
      await this.call('editForumTopic', { chat_id: this.chatId, message_thread_id: threadId, name })
    } catch (error) {
      this.onError(error)
    }
  }

  /** Enqueue one message; the outbox drains serially at the configured rate. */
  post(text, threadId) {
    if (this.queue.length >= this.maxQueue) {
      this.dropped++
      return
    }
    this.queue.push({ kind: 'send', text: text.slice(0, TELEGRAM_MAX), threadId })
    void this.drain()
  }

  /** Post and resolve with the message id, so it can be edited afterwards. */
  postTracked(text, threadId, options = {}) {
    return new Promise((resolve) => {
      if (this.queue.length >= this.maxQueue) {
        this.dropped++
        resolve(undefined)
        return
      }
      this.queue.push({
        kind: 'send',
        text: text.slice(0, TELEGRAM_MAX),
        threadId,
        parseMode: options.parseMode ?? 'HTML',
        keyboard: options.keyboard,
        resolve,
      })
      void this.drain()
    })
  }

  /**
   * Replace a message's text. Edits to the same message COALESCE: a streaming
   * answer redraws far faster than Telegram accepts edits, and only the latest
   * body is worth sending, so a queued edit for the same message is overwritten
   * rather than queued behind.
   */
  edit(messageId, text, threadId, options = {}) {
    if (messageId === undefined) return
    const body = text.slice(0, TELEGRAM_MAX)
    const pending = this.queue.find((item) => item.kind === 'edit' && item.messageId === messageId)
    if (pending !== undefined) {
      pending.text = body
      if (options.keyboard !== undefined) pending.keyboard = options.keyboard
      return
    }
    this.queue.push({ kind: 'edit', messageId, text: body, threadId, parseMode: options.parseMode ?? 'HTML', keyboard: options.keyboard })
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
          if (item.kind === 'edit') {
            await this.call('editMessageText', {
              chat_id: this.chatId,
              message_id: item.messageId,
              text: item.text,
              ...(item.parseMode === undefined ? {} : { parse_mode: item.parseMode }),
              ...(item.keyboard === undefined ? {} : { reply_markup: { inline_keyboard: item.keyboard } }),
              link_preview_options: { is_disabled: true },
            })
            this.edited++
          } else {
            const message = await this.call('sendMessage', {
              chat_id: this.chatId,
              text: item.text,
              ...(item.parseMode === undefined ? {} : { parse_mode: item.parseMode }),
              ...(item.keyboard === undefined ? {} : { reply_markup: { inline_keyboard: item.keyboard } }),
              link_preview_options: { is_disabled: true },
              ...(item.threadId === undefined ? {} : { message_thread_id: item.threadId }),
            })
            this.sent++
            item.resolve?.(message?.message_id)
          }
        } catch (error) {
          // A thread that no longer exists, or an edit that changed nothing,
          // must not wedge the outbox: report and keep draining.
          item.resolve?.(undefined)
          // "message is not modified" is the API telling us the redraw was a
          // no-op; that is normal for a coalesced stream, not a fault.
          if (!/not modified/i.test(error.message)) this.onError(error)
        }
      }
    }
  }
}
