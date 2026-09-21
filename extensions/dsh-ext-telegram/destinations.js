// Destination records: what a broadcast target is, how it is named, and what
// may be shown back to the browser. Pure — no dsh, no node, no network.

/** Credential reference holding one destination's bot token. */
export function tokenRef(id) {
  return `TELEGRAM_BOT_TOKEN_${String(id).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
}

/** A stable, readable id derived from a label, unique against `taken`. */
export function slugify(label, taken = []) {
  const base = String(label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'bot'
  if (!taken.includes(base)) return base
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`
    if (!taken.includes(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}

const MODES = ['stream', 'summary']
const TOOLS = ['compact', 'off']

/** Normalise one record coming from the browser; throws on anything unusable. */
export function normalize(input, existing = {}) {
  const label = String(input.label ?? existing.label ?? '').trim().slice(0, 64)
  if (label.length === 0) throw new Error('a name is required')
  const chatId = String(input.chatId ?? existing.chatId ?? '').trim()
  if (!/^-?\d+$/.test(chatId)) throw new Error('chat id must be a number, for example 123456789 or -1001234567890')
  const mode = MODES.includes(input.mode) ? input.mode : (existing.mode ?? 'stream')
  const tools = TOOLS.includes(input.tools) ? input.tools : (existing.tools ?? 'compact')
  return {
    id: existing.id ?? input.id,
    label,
    chatId,
    mode,
    tools,
    topics: input.topics === undefined ? (existing.topics ?? true) : input.topics === true,
    enabled: input.enabled === undefined ? (existing.enabled ?? true) : input.enabled === true,
    minRunSeconds: Number.isFinite(input.minRunSeconds) ? Math.max(0, Math.trunc(input.minRunSeconds)) : (existing.minRunSeconds ?? 45),
  }
}

/** What the browser may see: everything except anything token-shaped. */
export function redact(destination, extra = {}) {
  const { id, label, chatId, mode, tools, topics, enabled, minRunSeconds } = destination
  return { id, label, chatId, mode, tools, topics, enabled, minRunSeconds, ...extra }
}

/** Replace or append by id, preserving order. */
export function upsert(list, destination) {
  const at = list.findIndex((d) => d.id === destination.id)
  if (at === -1) return [...list, destination]
  const next = [...list]
  next[at] = destination
  return next
}

export function remove(list, id) {
  return list.filter((d) => d.id !== id)
}

/**
 * The implicit destination configured through the environment, for a
 * deployment wired before the panel existed. It is read-only: the panel cannot
 * edit what the launch environment owns.
 */
export function envDestination(env) {
  const token = env.TELEGRAM_BOT_TOKEN ?? ''
  const chatId = env.TELEGRAM_CHAT_ID ?? ''
  if (token.length === 0 || chatId.length === 0) return undefined
  return {
    id: 'env',
    label: 'Configured in deploy/.env',
    chatId,
    mode: 'stream',
    tools: 'compact',
    topics: true,
    enabled: true,
    minRunSeconds: 45,
    readOnly: true,
  }
}

/** Chats a getUpdates answer mentions, newest first, deduplicated. */
export function chatsFromUpdates(updates) {
  const seen = new Map()
  for (const update of Array.isArray(updates) ? updates : []) {
    for (const message of [update.message, update.channel_post, update.my_chat_member, update.edited_message]) {
      const chat = message?.chat
      if (chat?.id === undefined) continue
      const person = [chat.first_name, chat.last_name].filter(Boolean).join(' ')
      const title = chat.title ?? (person.length > 0 ? person : (chat.username ?? String(chat.id)))
      seen.set(String(chat.id), { id: String(chat.id), title, type: chat.type })
    }
  }
  return [...seen.values()].reverse()
}
