// Pure rendering of a session event into one broadcast line, plus the small
// rules around it (length, titles, elapsed time). No dsh or node imports.

/** Telegram refuses anything past 4096 characters. */
export const TELEGRAM_MAX = 4096

export function truncate(text, max = 3500) {
  const s = String(text)
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

/** Text of a content-block array, images and tool blocks reduced to a marker. */
export function blocksText(content) {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  return content.map((block) => {
    if (block?.type === 'text') return block.text
    if (block?.type === 'image') return '[image]'
    if (block?.type === 'file') return '[file]'
    return ''
  }).join('').trim()
}

/** One-line digest of tool arguments: the values a human recognises. */
export function argsDigest(args, max = 120) {
  if (args === null || args === undefined) return ''
  if (typeof args === 'string') return truncate(args, max)
  if (typeof args !== 'object') return String(args)
  const interesting = ['path', 'file_path', 'command', 'cmd', 'pattern', 'query', 'prompt', 'url', 'name']
  for (const key of interesting) {
    const value = args[key]
    if (typeof value === 'string' && value.length > 0) return truncate(value.replace(/\s+/g, ' '), max)
  }
  const first = Object.entries(args)[0]
  return first === undefined ? '' : truncate(`${first[0]}=${JSON.stringify(first[1])}`, max)
}

export function humanDuration(ms) {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return s % 60 === 0 ? `${m}m` : `${m}m ${s % 60}s`
}

/**
 * Map one durable session event to a broadcast line.
 * @returns `{ text, kind }` or undefined when the event is not broadcast.
 */
export function formatEvent(event, options = {}) {
  const tools = options.tools ?? 'compact'
  const data = event?.data ?? {}
  switch (event?.type) {
    case 'user/message': {
      // Tool results and plugin-authored context arrive as user-role events too.
      const source = data.source?.kind
      if (source !== undefined && source !== 'user') return undefined
      const text = blocksText(data.content)
      return text.length === 0 ? undefined : { kind: 'user', text: `👤 ${truncate(text)}` }
    }
    case 'assistant/message': {
      const text = blocksText(data.message?.content ?? data.content)
      return text.length === 0 ? undefined : { kind: 'assistant', text: `🤖 ${truncate(text)}` }
    }
    case 'tool/call': {
      if (tools === 'off') return undefined
      const digest = argsDigest(data.arguments)
      return { kind: 'tool', text: `⚙️ ${data.name}${digest ? `  ${digest}` : ''}` }
    }
    case 'approval/asked':
      return {
        kind: 'approval',
        text: `⏸ Ждёт твоего решения: ${data.toolName}${data.reason ? `\n${truncate(data.reason, 400)}` : ''}`,
      }
    case 'session/title':
      return { kind: 'title', text: `📝 ${truncate(data.title, 200)}` }
    default:
      return undefined
  }
}

/** Topic title for a session: its own title when it has one, else the first ask. */
export function topicTitle(seed, max = 96) {
  const text = String(seed ?? '').replace(/\s+/g, ' ').trim()
  if (text.length === 0) return 'dsh session'
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** The line closing a run. */
export function completionText(elapsedMs, usage) {
  const parts = [`✅ Готово за ${humanDuration(elapsedMs)}`]
  if (usage !== undefined && usage.total > 0) {
    parts.push(`${Math.round(usage.total / 1000)}k токенов${usage.cacheRead > 0 ? `, ${Math.round((usage.cacheRead / Math.max(usage.billedInput, 1)) * 100)}% из кэша` : ''}`)
  }
  return parts.join(' · ')
}

export function errorText(error) {
  const message = error instanceof Error ? error.message : String(error)
  return `⚠️ Ошибка: ${truncate(message, 600)}`
}
