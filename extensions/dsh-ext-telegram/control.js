// The remote control: what a message or a tapped button means, and what to
// answer. Dependencies are injected, so the whole grammar is testable without a
// harness, a network or a bot.
//
// The grammar is deliberately thin. Typing a task is the main path: with no
// session chosen the bridge opens one and gets to work, because being told to
// run `/sessions` and then `/use 2` before anything happens is a ritual, not an
// interface. Everything else is a button.

const HELP = [
  'Просто напиши задачу — я открою сессию и начну.',
  '',
  'Кнопки и команды:',
  '/sessions — список сессий, выбор по нажатию',
  '/workspaces — проекты, новая сессия по нажатию',
  '/new [проект] — новая сессия сразу',
  '/stop — прервать текущий ход',
  '/status — состояние трансляции',
  '',
  'В треде сессии ничего выбирать не нужно: что напишешь, уйдёт в неё.',
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

function projectOf(item, deps) {
  const workspace = deps.workspaceOf?.(item.cwd, deps.workspaces?.() ?? [])
  if (workspace !== undefined) return workspace.name ?? workspace.path.split('/').filter(Boolean).pop()
  return item.cwd === undefined ? undefined : item.cwd.split('/').filter(Boolean).pop()
}

/** Button label for one session: what it is, where it lives, whether it runs. */
export function sessionLabel(item, deps, now) {
  const project = projectOf(item, deps)
  const title = item.title ?? `сессия ${String(item.sessionId).slice(0, 6)}`
  return `${item.running ? '▶ ' : ''}${project ? `${project} · ` : ''}${title} · ${ago(now, item.updatedAt)}`.slice(0, 64)
}

/** The sessions screen: one button per session, plus a way to start a new one. */
export function sessionsScreen(items, deps, now = Date.now()) {
  if (items.length === 0) {
    return {
      text: 'Сессий пока нет. Напиши задачу — открою первую.',
      keyboard: [[{ text: '＋ Новая сессия', callback_data: 'new' }]],
    }
  }
  return {
    text: `Выбери сессию — дальше пиши сюда обычным текстом.\nВсего: ${items.length}`,
    keyboard: [
      ...items.map((item) => [{ text: sessionLabel(item, deps, now), callback_data: `pick:${item.sessionId}` }]),
      [{ text: '＋ Новая сессия', callback_data: 'new' }],
    ],
  }
}

/** The projects screen: tapping one starts a session in it. */
export function workspacesScreen(list) {
  if (list.length === 0) {
    return {
      text: 'Воркспейсов нет. Напиши задачу — открою сессию там, где стоит харнесс.',
      keyboard: [[{ text: '＋ Новая сессия', callback_data: 'new' }]],
    }
  }
  return {
    text: 'Проекты. Нажми — открою в нём новую сессию.',
    keyboard: list.map((workspace, index) => [{
      text: `📁 ${(workspace.name ?? workspace.path.split('/').filter(Boolean).pop() ?? '').slice(0, 40)}${workspace.sessions ? ` · ${workspace.sessions}` : ''}`,
      callback_data: `new:${index}`,
    }]),
  }
}

const HOME_KEYBOARD = [[
  { text: '🗂 Мои сессии', callback_data: 'list' },
  { text: '＋ Новая', callback_data: 'new' },
]]

/**
 * One chat's view of the harness: which session it writes to, and what the last
 * listing meant.
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

/** Start a session, remember it for this chat, and report it. */
async function openSession(message, deps, cwd) {
  const sessionId = await deps.create(cwd)
  deps.bindings.bind(message.chatId, message.threadId, sessionId)
  deps.adopt?.(message.chatId, message.threadId, sessionId)
  return sessionId
}

/**
 * Interpret one incoming message.
 * @returns {Promise<undefined | string | {text: string, keyboard?: object[][]}>}
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
      return { text: HELP, keyboard: HOME_KEYBOARD }
    case '/id':
      return `chat id: ${message.chatId}`
    case '/status':
      return deps.status()
    case '/start':
      return {
        text: [
          'Это пульт от харнесса.',
          '',
          'Напиши задачу — я открою сессию и начну работать. У каждой сессии здесь свой тред: в нём виден ответ, который пишется на глазах, что агент делает прямо сейчас, и итог с временем и расходом токенов. Цвет треда — это проект.',
          '',
          'Отвечай прямо в треде — выбирать ничего не нужно.',
        ].join('\n'),
        keyboard: HOME_KEYBOARD,
      }
    case '/sessions': {
      const items = await deps.sessions()
      bindings.remember(message.chatId, message.threadId, items.map((item) => item.sessionId))
      return sessionsScreen(items, deps, deps.now?.() ?? Date.now())
    }
    case '/workspaces':
      return workspacesScreen(deps.workspaces())
    case '/use': {
      // Kept for muscle memory; the list is buttons now.
      const n = positiveInt(rest[0])
      if (n === undefined) return { text: 'Выбери сессию кнопкой.', keyboard: HOME_KEYBOARD }
      const sessionId = bindings.numbered(message.chatId, message.threadId, n)
      if (sessionId === undefined) return { text: 'Этого номера нет в последнем списке.', keyboard: HOME_KEYBOARD }
      bindings.bind(message.chatId, message.threadId, sessionId)
      deps.adopt?.(message.chatId, message.threadId, sessionId)
      return 'Готово. Пиши текст — уйдёт в неё.'
    }
    case '/new': {
      // `/new` — where the harness stands; `/new 2` — the second project;
      // `/new site` — by name; `/new /abs/path` — anywhere.
      let cwd
      if (argument.length > 0) {
        const workspaces = deps.workspaces()
        const byNumber = positiveInt(argument)
        const chosen = byNumber !== undefined
          ? workspaces[byNumber - 1]
          : workspaces.find((workspace) => (workspace.name ?? '').toLowerCase() === argument.toLowerCase())
        if (chosen !== undefined) cwd = chosen.path
        else if (argument.startsWith('/')) cwd = argument
        else return { text: `Не нашёл проект «${argument}».`, keyboard: workspacesScreen(deps.workspaces()).keyboard }
      }
      await openSession(message, deps, cwd)
      return `Сессия открыта${cwd ? ` в ${cwd}` : ''}. Пиши задачу.`
    }
    case '/stop': {
      const sessionId = bindings.resolve(message.chatId, message.threadId, message.threadSession)
      if (sessionId === undefined) return 'Нечего прерывать.'
      deps.cancel(sessionId)
      return 'Прервал текущий ход.'
    }
    default: {
      if (command.startsWith('/')) return { text: `Не знаю команду ${command}.\n\n${HELP}`, keyboard: HOME_KEYBOARD }
      const bound = bindings.resolve(message.chatId, message.threadId, message.threadSession)
      if (bound !== undefined) {
        await deps.prompt(bound, text, message)
        return undefined
      }
      // Nothing chosen: open a session and start. Asking the operator to run
      // two commands before the first word of work is the opposite of a chat.
      const sessionId = await openSession(message, deps)
      await deps.prompt(sessionId, text, message)
      return undefined
    }
  }
}

/**
 * Interpret one tapped button.
 * @returns {Promise<{answer?: string, text?: string, keyboard?: object[][], edit?: boolean}>}
 */
export async function handleCallback(tap, deps) {
  const data = String(tap.data ?? '')
  const message = { chatId: tap.chatId, threadId: tap.threadId }

  if (data === 'list') {
    const items = await deps.sessions()
    deps.bindings.remember(tap.chatId, tap.threadId, items.map((item) => item.sessionId))
    return { ...sessionsScreen(items, deps, deps.now?.() ?? Date.now()), edit: true }
  }

  if (data === 'new' || data.startsWith('new:')) {
    let cwd
    if (data.startsWith('new:')) {
      const index = positiveInt(data.slice('new:'.length))
      const workspace = index === undefined ? undefined : deps.workspaces()[index]
      if (workspace === undefined) return { answer: 'Проект не найден', edit: false }
      cwd = workspace.path
    }
    await openSession(message, deps, cwd)
    return {
      answer: 'Сессия открыта',
      text: `Сессия открыта${cwd ? ` в ${cwd}` : ''}. Напиши задачу — начну.`,
      edit: true,
    }
  }

  if (data.startsWith('pick:')) {
    const sessionId = data.slice('pick:'.length)
    deps.bindings.bind(tap.chatId, tap.threadId, sessionId)
    deps.adopt?.(tap.chatId, tap.threadId, sessionId)
    const items = await deps.sessions()
    const chosen = items.find((item) => item.sessionId === sessionId)
    return {
      answer: 'Выбрано',
      text: chosen === undefined
        ? 'Сессия выбрана. Пиши текст — уйдёт в неё.'
        : `Пишу в «${sessionLabel(chosen, deps, deps.now?.() ?? Date.now())}».\nОтправь текст.`,
      edit: true,
    }
  }

  return { answer: 'Не понял кнопку' }
}

export { HELP, HOME_KEYBOARD }
