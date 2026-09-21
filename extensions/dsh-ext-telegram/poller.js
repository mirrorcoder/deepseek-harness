// Long-polling half of the bridge: keeps one `getUpdates` consumer per bot so
// the bot can answer, and remembers which chats it has seen so the panel can
// offer them. What an incoming message MEANS is not decided here — that is
// `control.js`, handed in as `onMessage`.
//
// Telegram allows exactly one consumer per token — a second one answers 409 —
// so a conflict stops this poller loudly instead of fighting.
//
// The API call is injected, so the loop is testable without a network.

/** The chat of any update shape we care about. */
export function chatOf(update) {
  const message = update?.message ?? update?.edited_message ?? update?.channel_post ?? update?.my_chat_member
  const chat = message?.chat
  if (chat?.id === undefined) return undefined
  const person = [chat.first_name, chat.last_name].filter(Boolean).join(' ')
  return {
    id: String(chat.id),
    title: chat.title ?? (person.length > 0 ? person : (chat.username ?? String(chat.id))),
    type: chat.type,
    text: message?.text,
    threadId: message?.message_thread_id,
  }
}

export class UpdatePoller {
  /**
   * @param {{api: (method: string, payload?: object) => Promise<any>,
   *          onChat: (chat: object) => void,
   *          reply: (chatId: string, text: string, threadId?: number) => void,
   *          onMessage: (chat: object) => Promise<string | undefined>,
   *          timeout?: number, onError?: (e: Error) => void,
   *          sleep?: (ms: number) => Promise<void>}} o
   */
  constructor(o) {
    this.api = o.api
    this.onChat = o.onChat ?? (() => {})
    this.reply = o.reply ?? (() => {})
    this.onMessage = o.onMessage
    this.timeout = o.timeout ?? 25
    this.onError = o.onError ?? (() => {})
    /** Called after a round that reached Telegram, so a stale failure can clear. */
    this.onOk = o.onOk ?? (() => {})
    this.sleep = o.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.offset = undefined
    this.stopped = false
    this.conflict = false
    this.rounds = 0
  }

  /** One `getUpdates` round; returns how many updates it handled. */
  async round() {
    const updates = await this.api('getUpdates', {
      timeout: this.timeout,
      ...(this.offset === undefined ? {} : { offset: this.offset }),
      allowed_updates: ['message', 'my_chat_member'],
    })
    this.rounds++
    this.onOk()
    for (const update of Array.isArray(updates) ? updates : []) {
      if (typeof update.update_id === 'number') this.offset = update.update_id + 1
      const chat = chatOf(update)
      if (chat === undefined) continue
      this.onChat(chat)
      if (this.onMessage === undefined) continue
      // Answering is asynchronous — it may create a session or hand a prompt to
      // an agent — but the round must not wait on it: the next batch of updates
      // is already due, and a slow harness must not stall consumption.
      void Promise.resolve(this.onMessage(chat))
        .then((answer) => {
          if (answer !== undefined && answer !== '') this.reply(chat.id, answer, chat.threadId)
        })
        .catch((error) => this.onError(error))
    }
    return Array.isArray(updates) ? updates.length : 0
  }

  /** Loop until stopped; a conflicting consumer ends it, other errors back off. */
  async run() {
    let backoff = 1000
    while (!this.stopped) {
      try {
        await this.round()
        backoff = 1000
      } catch (error) {
        if (/conflict/i.test(error.message) || error.code === 409) {
          this.conflict = true
          this.onError(new Error(`another process is already receiving this bot's updates, so it cannot answer here: ${error.message}`))
          return
        }
        this.onError(error)
        await this.sleep(backoff)
        backoff = Math.min(backoff * 2, 60_000)
      }
    }
  }

  stop() {
    this.stopped = true
  }
}
