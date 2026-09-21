// One Telegram message per turn, edited as the answer streams in.
//
// Telegram is not a log: a wall of one-line tool messages is unreadable on a
// phone and burns the per-chat message budget. A turn is therefore ONE message
// that grows — the answer as it is written, a status line naming what the agent
// is doing right now, and a footer with duration and token cost once it is
// done. Edits are coalesced by the outbox, so a fast stream costs a couple of
// API calls per second, not one per token.
//
// Rendering is pure (`renderRun`); the view only decides when to redraw.

import { escapeHtml, toTelegramHtml } from './markdown.js'

const MAX = 3600

export { escapeHtml }

/** Keep the tail of a long answer: the end is what a reader needs. */
export function clampTail(text, max = MAX) {
  const s = String(text)
  return s.length <= max ? s : `…${s.slice(s.length - max + 1)}`
}

/**
 * The message body for one turn.
 * @param {{text: string, tool?: {name: string, detail?: string}, done?: boolean,
 *          footer?: string, waiting?: boolean}} state
 */
export function renderRun(state) {
  const parts = []
  const body = clampTail(state.text ?? '')
  // The model writes Markdown; Telegram renders a small HTML subset. Convert
  // rather than escape, or tables and bold arrive as punctuation.
  if (body.trim().length > 0) parts.push(toTelegramHtml(body))
  if (!state.done) {
    const tool = state.tool
    parts.push(tool === undefined
      ? '<i>⚙️ думаю…</i>'
      : `<i>⚙️ ${escapeHtml(tool.name)}${tool.detail ? ` · <code>${escapeHtml(tool.detail)}</code>` : ''}</i>`)
  } else if (state.footer !== undefined && state.footer.length > 0) {
    parts.push(`<i>${escapeHtml(state.footer)}</i>`)
  }
  const text = parts.join('\n\n')
  return text.length === 0 ? '<i>⚙️ думаю…</i>' : text
}

/**
 * A live turn message. `client` supplies `postTracked(text, threadId, options)`
 * returning a message id, and `edit(messageId, text, threadId, options)`.
 */
export class RunView {
  constructor(client, threadId, options = {}) {
    this.client = client
    this.threadId = threadId
    this.intervalMs = options.intervalMs ?? 1500
    this.now = options.now ?? (() => Date.now())
    this.text = ''
    this.tool = undefined
    this.done = false
    this.footer = undefined
    this.messageId = undefined
    this.opening = undefined
    this.lastDrawAt = 0
    this.pending = false
    this.timer = undefined
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms))
    this.clear = options.clear ?? ((handle) => clearTimeout(handle))
  }

  /** Post the placeholder so the thread shows activity immediately. */
  open() {
    if (this.opening !== undefined) return this.opening
    this.opening = Promise.resolve(this.client.postTracked(renderRun(this), this.threadId))
      .then((id) => { this.messageId = id })
      .catch(() => { this.messageId = undefined })
    return this.opening
  }

  appendText(delta) {
    if (typeof delta !== 'string' || delta.length === 0) return
    this.text += delta
    this.draw()
  }

  setTool(name, detail) {
    this.tool = { name, detail }
    this.draw()
  }

  /** Final redraw: always immediate, never dropped. */
  async finish(footer) {
    this.done = true
    this.footer = footer
    if (this.timer !== undefined) {
      this.clear(this.timer)
      this.timer = undefined
    }
    await this.open()
    await this.redraw()
  }

  /** Redraw now if the interval has passed, otherwise once it does. */
  draw() {
    if (this.done) return
    const elapsed = this.now() - this.lastDrawAt
    if (elapsed >= this.intervalMs) {
      void this.redraw()
      return
    }
    if (this.timer !== undefined) return
    this.timer = this.schedule(() => {
      this.timer = undefined
      void this.redraw()
    }, this.intervalMs - elapsed)
  }

  async redraw() {
    await this.open()
    if (this.messageId === undefined) return
    this.lastDrawAt = this.now()
    await this.client.edit(this.messageId, renderRun(this), this.threadId)
  }
}
