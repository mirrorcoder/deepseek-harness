// The remote control: what a message from Telegram means and what to answer.
// Dependencies are injected, so the whole grammar is testable without a
// harness, a network or a bot.

const HELP = [
  'Команды:',
  '/workspaces — проекты, подключённые к харнессу',
  '/sessions — сессии, сгруппированные по проектам',
  '/new [проект] — новая сессия: номер или имя из /workspaces, либо путь',
  '/use N — писать в сессию N из этого чата',
  '/stop — прервать текущий ход',
  '/status — куда настроена трансляция',
  '/id — chat id',
  '',
  'Обычный текст уходит в выбранную сессию. В треде сессии выбирать ничего не нужно — пиши прямо там.',
].join('\n')

/** `123` → 123, anything else → undefined. */
function positiveInt(word) {
  return /^\d+$/.test(String(word ?? '')) ? Number(word) : undefined
}

function ago(now, then) {
  // Floor, not round: anything inside the last minute is "just now", and
  // rounding turned a 30-second-old session into "1 min ago".
  const minutes = Math.max(0, Math.floor((now - then) / 60_000))
  if (minutes < 1) return 'только что'
  if (minutes < 60) return `${minutes} мин назад`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours} ч назад` : `${Math.floor(hours / 24)} дн назад`
}

/**
 * Sessions grouped by the workspace they live in, numbered continuously so one
 * `/use N` addresses any of them. The grouping is the point: the list reads
 * like the sidebar rather than like a log.
 */
export function formatSessions(items, options = {}) {
  if (items.length === 0) return 'Сессий пока нет.\n/new — создать первую.'
  const now = options.now ?? Date.now()
  const workspaces = options.workspaces ?? []
  const groups = new Map()
  items.forEach((item, index) => {
    const workspace = options.workspaceOf?.(item.cwd, workspaces)
    const key = workspace?.path ?? item.cwd ?? '—'
    const title = workspace?.name ?? (key === '—' ? 'без папки' : key.split('/').filter(Boolean).pop())
    if (!groups.has(key)) groups.set(key, { title, rows: [] })
    groups.get(key).rows.push(
      `  ${index + 1}. ${item.running ? '▶' : '·'} ${item.title ?? item.sessionId.slice(0, 8)} · ${ago(now, item.updatedAt)}`,
    )
  })
  const blocks = [...groups.values()].map((group) => [`📁 ${group.title}`, ...group.rows].join('\n'))
  return [...blocks, '', '/use N — писать в сессию отсюда. В треде сессии выбирать ничего не нужно.'].join('\n')
}

export function formatWorkspaces(list) {
  if (list.length === 0) return 'Воркспейсов нет.\n/new <путь> — создать сессию в папке.'
  const rows = list.map((w, i) => `${i + 1}. 📁 ${w.name ?? w.path.split('/').filter(Boolean).pop()} · ${w.path}${w.sessions === undefined ? '' : ` · сессий: ${w.sessions}`}`)
  return [...rows, '', '/new N — новая сессия в воркспейсе N'].join('\n')
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
        'Это пульт от харнесса.',
        '',
        'Каждая сессия получает здесь свой тред: в нём видно вопрос, ответ, каждый инструмент, запросы подтверждения и итог с временем и расходом токенов. Цвет треда — это проект, так что ветки одного репозитория выглядят одинаково.',
        '',
        'С чего начать:',
        '1. /workspaces — какие проекты подключены',
        '2. /new 1 — новая сессия в первом из них',
        '3. напиши задачу обычным текстом',
        '',
        'Дальше отвечай прямо в треде сессии — выбирать ничего не нужно.',
        '',
        `chat id: ${message.chatId}`,
      ].join('\n')
    case '/sessions': {
      const items = await deps.sessions()
      bindings.remember(message.chatId, message.threadId, items.map((i) => i.sessionId))
      return formatSessions(items, {
        now: deps.now?.(),
        workspaces: deps.workspaces(),
        workspaceOf: deps.workspaceOf,
      })
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
      // `/new` — where the harness stands; `/new 2` — the second workspace;
      // `/new site` — by name; `/new /abs/path` — anywhere.
      let cwd
      if (argument.length > 0) {
        const workspaces = deps.workspaces()
        const byNumber = positiveInt(argument)
        const chosen = byNumber !== undefined
          ? workspaces[byNumber - 1]
          : workspaces.find((w) => (w.name ?? '').toLowerCase() === argument.toLowerCase())
        if (chosen !== undefined) cwd = chosen.path
        else if (argument.startsWith('/')) cwd = argument
        else return `Не нашёл воркспейс «${argument}». /workspaces — список, или укажи путь от корня.`
      }
      const sessionId = await deps.create(cwd)
      bindings.bind(message.chatId, message.threadId, sessionId)
      return [
        `Сессия создана${cwd ? ` в ${cwd}` : ''}.`,
        'Пиши сюда — уйдёт в неё. Как только она заговорит, у неё появится свой тред.',
      ].join('\n')
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
