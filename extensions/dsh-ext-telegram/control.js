// The remote control: what a message from Telegram means and what to answer.
// Dependencies are injected, so the whole grammar is testable without a
// harness, a network or a bot.

const HELP = [
  'Что я понимаю:',
  '/sessions — список сессий, каждая с номером',
  '/use N — привязать этот чат к сессии N',
  '/new [путь] — новая сессия (в воркспейсе по пути, иначе в текущем)',
  '/workspaces — воркспейсы',
  '/stop — прервать текущий ход',
  '/status — куда настроена трансляция',
  '/id — chat id',
  '',
  'Обычный текст уходит в привязанную сессию. В треде сессии ничего привязывать не нужно — пиши прямо там.',
].join('\n')

/** `123` → 123, anything else → undefined. */
function positiveInt(word) {
  return /^\d+$/.test(String(word ?? '')) ? Number(word) : undefined
}

export function formatSessions(items, options = {}) {
  if (items.length === 0) return 'Сессий пока нет. /new — создать.'
  const now = options.now ?? Date.now()
  const lines = items.map((item, index) => {
    // Floor, not round: anything inside the last minute is "just now", and
    // rounding turned a 30-second-old session into "1 min ago".
    const age = Math.max(0, Math.floor((now - item.updatedAt) / 60_000))
    const when = age < 1 ? 'только что' : age < 60 ? `${age} мин назад` : `${Math.round(age / 60)} ч назад`
    const where = item.cwd === undefined ? '' : ` · ${item.cwd.split('/').slice(-2).join('/')}`
    return `${index + 1}. ${item.running ? '▶' : '·'} ${item.title ?? item.sessionId.slice(0, 8)}${where} · ${when}`
  })
  return [...lines, '', '/use N — писать в неё отсюда'].join('\n')
}

export function formatWorkspaces(list) {
  if (list.length === 0) return 'Воркспейсов нет. /new <путь> — создать сессию в папке.'
  return list.map((w, i) => `${i + 1}. ${w.name ?? w.path.split('/').pop()} · ${w.path}${w.sessions === undefined ? '' : ` · сессий: ${w.sessions}`}`).join('\n')
}

/**
 * One chat's view of the harness: which session it writes to, and what the
 * numbers in the last listing meant.
 */
export class Bindings {
  constructor() {
    this.bound = new Map()
    this.listings = new Map()
  }

  static key(chatId, threadId) {
    return `${chatId}:${threadId ?? ''}`
  }

  bind(chatId, threadId, sessionId) {
    this.bound.set(Bindings.key(chatId, threadId), sessionId)
  }

  /** The session this message should reach: its own thread first, then the chat. */
  resolve(chatId, threadId, threadSession) {
    if (threadSession !== undefined) return threadSession
    return this.bound.get(Bindings.key(chatId, threadId)) ?? this.bound.get(Bindings.key(chatId, undefined))
  }

  remember(chatId, threadId, sessionIds) {
    this.listings.set(Bindings.key(chatId, threadId), sessionIds)
  }

  numbered(chatId, threadId, n) {
    const list = this.listings.get(Bindings.key(chatId, threadId)) ?? this.listings.get(Bindings.key(chatId, undefined)) ?? []
    return list[n - 1]
  }
}

/**
 * Interpret one incoming message.
 * @param {{text: string, chatId: string, threadId?: number, threadSession?: string}} message
 * @param {{bindings: Bindings, sessions: () => Promise<object[]>, workspaces: () => object[],
 *          create: (cwd?: string) => Promise<string>, prompt: (sessionId: string, text: string) => Promise<void>,
 *          cancel: (sessionId: string) => void, status: () => string, now?: () => number}} deps
 * @returns {Promise<string | undefined>} what to reply, or undefined to stay silent
 */
export async function handleMessage(message, deps) {
  const text = String(message.text ?? '').trim()
  if (text.length === 0) return undefined
  const [word, ...rest] = text.split(/\s+/)
  const command = word.toLowerCase().replace(/@.*$/, '')
  const argument = rest.join(' ').trim()
  const { bindings } = deps

  switch (command) {
    case '/help':
      return HELP
    case '/id':
      return `chat id: ${message.chatId}`
    case '/status':
      return deps.status()
    case '/start':
      return [
        'Готово — этот чат теперь виден харнессу.',
        `chat id: ${message.chatId}`,
        '',
        HELP,
      ].join('\n')
    case '/sessions': {
      const items = await deps.sessions()
      bindings.remember(message.chatId, message.threadId, items.map((i) => i.sessionId))
      return formatSessions(items, { now: deps.now?.() })
    }
    case '/workspaces':
      return formatWorkspaces(deps.workspaces())
    case '/use': {
      const n = positiveInt(rest[0])
      if (n === undefined) return 'Номер сессии: /use 1. Список — /sessions.'
      const sessionId = bindings.numbered(message.chatId, message.threadId, n)
      if (sessionId === undefined) return 'Сначала /sessions, потом /use N из этого списка.'
      bindings.bind(message.chatId, message.threadId, sessionId)
      return `Готово: пишу в сессию ${n}. Просто отправь текст.`
    }
    case '/new': {
      const sessionId = await deps.create(argument.length > 0 ? argument : undefined)
      bindings.bind(message.chatId, message.threadId, sessionId)
      return `Новая сессия создана${argument ? ` в ${argument}` : ''}. Пиши текст — уйдёт в неё.`
    }
    case '/stop': {
      const sessionId = bindings.resolve(message.chatId, message.threadId, message.threadSession)
      if (sessionId === undefined) return 'Нечего прерывать: сессия не привязана.'
      deps.cancel(sessionId)
      return 'Прервал текущий ход.'
    }
    default: {
      if (command.startsWith('/')) return `Не знаю команду ${command}.\n\n${HELP}`
      const sessionId = bindings.resolve(message.chatId, message.threadId, message.threadSession)
      if (sessionId === undefined) {
        return 'Некуда отправить: сессия не привязана. /sessions → /use N, или /new.'
      }
      await deps.prompt(sessionId, text)
      return undefined
    }
  }
}

export { HELP }
