// Markdown as the model writes it → the small HTML subset Telegram renders.
//
// Telegram knows <b> <i> <u> <s> <a> <code> <pre> <blockquote> and nothing
// else: no headings, no lists, no tables. A model answer full of `##`, `|` and
// `**` therefore arrives as punctuation soup. This turns it into something a
// person reads on a phone:
//
//   * headings become bold lines, bullets become •, rules disappear;
//   * tables become aligned monospace blocks, which is the only way a table
//     survives on a narrow screen;
//   * fences become <pre>, and an unclosed one (the usual state mid-stream) is
//     closed for the render rather than swallowing the rest of the answer.
//
// Pure functions, no imports: the renderer is testable on its own.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }

export function escapeHtml(value) {
  return String(value).replace(/[&<>]/g, (character) => ESCAPES[character])
}

/** Visible width of a cell, for aligning a table. */
function width(text) {
  return [...String(text)].length
}

function pad(text, size) {
  const missing = size - width(text)
  return missing > 0 ? text + ' '.repeat(missing) : text
}

/** `| a | b |` → `['a','b']`, tolerating missing outer pipes. */
export function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

const SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

/**
 * A table cell is rendered inside <pre>, where Telegram applies no marks, so
 * the markers themselves would show as punctuation. Drop them and keep the
 * words.
 */
export function plainInline(text) {
  return String(text)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
}

/**
 * Render one Markdown table as an aligned monospace block. Columns are capped
 * so a wide table wraps predictably instead of becoming a horizontal maze.
 */
export function renderTable(rows, maxColumnWidth = 28) {
  const cells = rows.map((row) => splitRow(row).map(plainInline))
  const columns = Math.max(...cells.map((row) => row.length))
  const widths = []
  for (let column = 0; column < columns; column++) {
    const longest = Math.max(...cells.map((row) => width(row[column] ?? '')))
    widths.push(Math.min(longest, maxColumnWidth))
  }
  const clip = (text, size) => (width(text) <= size ? text : `${[...text].slice(0, size - 1).join('')}…`)
  const lines = cells.map((row) => widths
    .map((size, column) => pad(clip(row[column] ?? '', size), size))
    .join('  ')
    .replace(/\s+$/, ''))
  const [head, ...rest] = lines
  const rule = widths.map((size) => '─'.repeat(size)).join('  ')
  return `<pre>${escapeHtml([head, rule, ...rest].join('\n'))}</pre>`
}

/** Inline marks inside one already-escaped line. */
export function renderInline(text) {
  return text
    .replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
}

/**
 * Convert a Markdown answer to Telegram HTML.
 * @param {string} source - what the model wrote, possibly mid-sentence.
 */
export function toTelegramHtml(source) {
  const lines = String(source ?? '').split('\n')
  const out = []
  let fence
  let fenceBody = []
  let table = []

  const flushTable = () => {
    if (table.length === 0) return
    // A single line that merely looks like a row is not a table.
    if (table.length < 2) out.push(renderInline(escapeHtml(table[0])))
    else out.push(renderTable(table))
    table = []
  }
  const flushFence = () => {
    if (fence === undefined) return
    out.push(`<pre>${escapeHtml(fenceBody.join('\n'))}</pre>`)
    fence = undefined
    fenceBody = []
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    const fenceMark = /^\s*```/.test(line)
    if (fence !== undefined) {
      if (fenceMark) flushFence()
      else fenceBody.push(raw)
      continue
    }
    if (fenceMark) {
      flushTable()
      fence = line.trim().slice(3)
      continue
    }
    // Tables: collect consecutive pipe rows, drop the separator line.
    if (/^\s*\|.*\|\s*$/.test(line) || (table.length > 0 && SEPARATOR.test(line))) {
      if (!SEPARATOR.test(line)) table.push(line)
      continue
    }
    flushTable()

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      out.push(`<b>${renderInline(escapeHtml(heading[2]))}</b>`)
      continue
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) continue
    const quote = /^>\s?(.*)$/.exec(line)
    if (quote !== null) {
      out.push(`<blockquote>${renderInline(escapeHtml(quote[1]))}</blockquote>`)
      continue
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    if (bullet !== null) {
      out.push(`${bullet[1]}• ${renderInline(escapeHtml(bullet[2]))}`)
      continue
    }
    out.push(renderInline(escapeHtml(line)))
  }
  // A stream is usually cut mid-construct; render what is there rather than
  // dropping the tail.
  flushFence()
  flushTable()
  return out.join('\n')
}
