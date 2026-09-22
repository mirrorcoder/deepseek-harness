// The two moments the harness stops and waits for a human — an approval and a
// question — rendered as Telegram buttons.
//
// Both arrive on Cordis waterfalls (`approval/request`, `user-questions/request`)
// where an answerer either claims the request or delegates with `next()`. This
// desk claims nothing on its own: it puts the question in the session's thread
// and hands the caller a promise, so the bridge can race that promise against
// the browser's own answer. Whoever taps first wins; the loser's screen is
// rewritten to say so, and nothing is left hanging.
//
// Everything here is pure or injected: `io.post` returns a message id, `io.edit`
// replaces one. No Telegram, no dsh, no network — so the whole grammar of
// asking is testable.
import { escapeHtml } from './markdown.js'

/** Callback-data prefix owned by this desk; Telegram caps that payload at 64 bytes. */
export const ASK_PREFIX = 'ask:'

const OPTION_LABEL_MAX = 60

function truncate(text, max) {
  const s = String(text ?? '')
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

function threadKey(place) {
  return `${place?.chatId}:${place?.threadId ?? ''}`
}

/** The screen one approval request is shown as. */
export function approvalScreen(id, request) {
  const lines = ['⚠️ <b>Нужно разрешение</b>', `Инструмент: <code>${escapeHtml(request?.toolName ?? '?')}</code>`]
  if (request?.reason) lines.push(escapeHtml(truncate(request.reason, 600)))
  lines.push('<i>Разрешение действует на одно это действие.</i>')
  return {
    text: lines.join('\n'),
    keyboard: [[
      { text: '✅ Разрешить', callback_data: `${ASK_PREFIX}${id}:y` },
      { text: '⛔ Отклонить', callback_data: `${ASK_PREFIX}${id}:n` },
    ]],
  }
}

/** Button text for one option: a checkbox only where more than one may be picked. */
function optionLabel(option, multi, chosen) {
  const mark = multi ? (chosen ? '☑️ ' : '⬜️ ') : ''
  return truncate(`${mark}${option?.label ?? ''}`, OPTION_LABEL_MAX)
}

/**
 * The screen one question is shown as. Option descriptions go in the body, not
 * in the labels: a Telegram button is one short line and cuts the rest off.
 */
export function questionScreen(id, question, selected = []) {
  const parts = []
  if (question?.header) parts.push(`<b>${escapeHtml(question.header)}</b>`)
  parts.push(`❓ ${escapeHtml(truncate(question?.question ?? '', 900))}`)
  if (question?.detail) parts.push(`<i>${escapeHtml(truncate(question.detail, 1200))}</i>`)
  const options = Array.isArray(question?.options) ? question.options : []
  const described = options.filter((option) => option?.description)
  if (described.length > 0) {
    parts.push(described.map((option) => `• <b>${escapeHtml(option.label)}</b> — ${escapeHtml(truncate(option.description, 200))}`).join('\n'))
  }
  const multi = question?.multiSelect === true
  const keyboard = options.map((option, index) => [{
    text: optionLabel(option, multi, selected.includes(option?.label)),
    callback_data: `${ASK_PREFIX}${id}:o${index}`,
  }])
  if (multi && options.length > 0) {
    keyboard.push([{ text: '✔️ Готово', callback_data: `${ASK_PREFIX}${id}:done` }])
  }
  keyboard.push([{ text: '✏️ Ответить текстом', callback_data: `${ASK_PREFIX}${id}:txt` }])
  return { text: parts.join('\n\n'), keyboard }
}

/**
 * What one tap means for the question on screen. Pure: the desk applies it.
 * @returns {{kind: 'toggle', selected: string[]} | {kind: 'answer', item: object}
 *   | {kind: 'text'} | {kind: 'unknown'}}
 */
export function tapQuestion(question, selected, action) {
  const multi = question?.multiSelect === true
  if (action === 'txt') return { kind: 'text' }
  if (action === 'done') {
    return { kind: 'answer', item: { id: question?.id, selected: [...selected] } }
  }
  const index = /^o(\d+)$/.exec(String(action ?? ''))
  if (index === null) return { kind: 'unknown' }
  const option = (question?.options ?? [])[Number(index[1])]
  if (option === undefined) return { kind: 'unknown' }
  if (!multi) return { kind: 'answer', item: { id: question?.id, selected: [option.label] } }
  const next = selected.includes(option.label)
    ? selected.filter((label) => label !== option.label)
    : [...selected, option.label]
  return { kind: 'toggle', selected: next }
}

/** The closing line one settled ask leaves behind. */
export function closingText(screenText, note) {
  return `${screenText}\n\n<i>${escapeHtml(note)}</i>`
}

/**
 * Pending asks and their screens.
 *
 * `io.post(place, text, keyboard)` resolves the message id (or undefined when
 * it could not be sent); `io.edit(place, messageId, text, keyboard)` replaces
 * it — an empty keyboard removes the buttons.
 */
export class AskDesk {
  constructor(io = {}) {
    this.io = io
    this.now = io.now ?? (() => Date.now())
    /** id → pending record. */
    this.pending = new Map()
    /** `chatId:threadId` → id of the ask that may take a typed answer. */
    this.threads = new Map()
    this.counter = 0
  }

  /** Whether this callback payload belongs to the desk. */
  owns(data) {
    return String(data ?? '').startsWith(ASK_PREFIX)
  }

  /** Forget asks nobody ever settled, so a long-lived process does not grow. */
  prune(maxAgeMs = 6 * 3600_000) {
    for (const [id, entry] of this.pending) {
      if (this.now() - entry.at > maxAgeMs) this.drop(id)
    }
  }

  drop(id) {
    const entry = this.pending.get(id)
    if (entry === undefined) return undefined
    this.pending.delete(id)
    for (const [key, held] of this.threads) if (held === id) this.threads.delete(key)
    return entry
  }

  async open(place, kind, screen, extra) {
    this.prune()
    const id = String(++this.counter)
    const built = screen(id)
    const messageId = await this.io.post(place, built.text, built.keyboard)
    if (messageId === undefined) return undefined
    const entry = { id, kind, place, messageId, screen: built, at: this.now(), ...extra }
    entry.promise = new Promise((resolve) => {
      entry.resolve = resolve
    })
    this.pending.set(id, entry)
    if (kind === 'question') this.threads.set(threadKey(place), id)
    return entry
  }

  /** Put one approval on screen. Resolves with the outcome once it is tapped. */
  approval(place, request) {
    return this.open(place, 'approval', (id) => approvalScreen(id, request))
  }

  /** Put one question list on screen; the answer arrives when the last is answered. */
  question(place, questions) {
    const list = (questions ?? []).filter((item) => item !== null && item !== undefined)
    if (list.length === 0) return Promise.resolve(undefined)
    return this.open(
      place,
      'question',
      (id) => questionScreen(id, list[0], []),
      { questions: list, index: 0, selected: [], answers: [], awaitingText: false },
    )
  }

  /** Redraw one pending ask in place. */
  redraw(entry, built) {
    entry.screen = built
    this.io.edit(entry.place, entry.messageId, built.text, built.keyboard)
  }

  /** Close one ask: strip the buttons, say what happened, resolve its promise. */
  settle(id, note, value) {
    const entry = this.drop(id)
    if (entry === undefined) return
    this.io.edit(entry.place, entry.messageId, closingText(entry.screen.text, note), [])
    entry.resolve?.(value)
  }

  /**
   * Withdraw an ask answered somewhere else (the web UI, an abort). The promise
   * settles as `undefined`: the caller already has its winner.
   */
  close(id, note) {
    this.settle(id, note, undefined)
  }

  /** Apply one tapped button. */
  async tap(event) {
    const payload = String(event?.data ?? '').slice(ASK_PREFIX.length)
    const at = payload.indexOf(':')
    const id = at === -1 ? payload : payload.slice(0, at)
    const action = at === -1 ? '' : payload.slice(at + 1)
    const entry = this.pending.get(id)
    if (entry === undefined) return { answer: 'Этот вопрос уже закрыт' }

    if (entry.kind === 'approval') {
      if (action !== 'y' && action !== 'n') return { answer: 'Не понял кнопку' }
      const allowed = action === 'y'
      this.settle(id, allowed ? '✅ Разрешено' : '⛔ Отклонено', allowed ? 'allowed-once' : 'rejected')
      return { answer: allowed ? 'Разрешено' : 'Отклонено' }
    }

    const question = entry.questions[entry.index]
    const step = tapQuestion(question, entry.selected, action)
    if (step.kind === 'unknown') return { answer: 'Не понял кнопку' }
    if (step.kind === 'toggle') {
      entry.selected = step.selected
      this.redraw(entry, questionScreen(id, question, entry.selected))
      return { answer: 'Отмечено' }
    }
    if (step.kind === 'text') {
      entry.awaitingText = true
      this.threads.set(threadKey(entry.place), id)
      this.redraw(entry, {
        ...entry.screen,
        text: `${entry.screen.text}\n\n<i>Напиши ответ сообщением сюда же.</i>`,
      })
      return { answer: 'Жду текст' }
    }
    await this.advance(entry, step.item)
    return { answer: 'Принято' }
  }

  /** A typed answer for the question waiting on text in this thread. */
  async text(chatId, threadId, body) {
    const id = this.threads.get(`${chatId}:${threadId ?? ''}`)
    const entry = id === undefined ? undefined : this.pending.get(id)
    if (entry === undefined || entry.kind !== 'question' || entry.awaitingText !== true) return false
    const text = String(body ?? '').trim()
    if (text.length === 0) return false
    await this.advance(entry, { id: entry.questions[entry.index]?.id, selected: [], custom: text })
    return true
  }

  /** Record one question's answer and move to the next, or finish the list. */
  async advance(entry, item) {
    entry.answers.push(item)
    entry.index += 1
    entry.selected = []
    entry.awaitingText = false
    const next = entry.questions[entry.index]
    if (next === undefined) {
      this.settle(entry.id, `✔️ Ответ принят: ${answerNote(entry.answers)}`, { answers: entry.answers })
      return
    }
    this.redraw(entry, questionScreen(entry.id, next, []))
  }
}

/** One line naming what the human chose, for the closed screen. */
export function answerNote(answers) {
  const parts = []
  for (const answer of answers ?? []) {
    const chosen = [...(answer.selected ?? []), ...(answer.custom === undefined ? [] : [answer.custom])]
    if (chosen.length > 0) parts.push(truncate(chosen.join(', '), 120))
  }
  return parts.length === 0 ? '—' : parts.join(' · ')
}
