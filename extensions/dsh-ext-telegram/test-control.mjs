// Remote-control tests. Run inside the dsh container:
//   node --test /data/dsh/profiles/web/node_modules/dsh-ext-telegram/test-control.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Bindings, handleCallback, handleMessage, matchMode, modeScreen, sessionLabel, sessionsScreen, workspacesScreen } from './control.js'
import { workspaceOf } from './topics.js'

const NOW = 1_700_000_000_000
const items = [
  { sessionId: 'aaaaaaaa-1111', updatedAt: NOW - 30_000, running: true, blank: false, cwd: '/workspace/deepseek-harness', title: 'Fix the login bug' },
  { sessionId: 'bbbbbbbb-2222', updatedAt: NOW - 3 * 3_600_000, running: false, blank: false, cwd: '/workspace/projects/site' },
]

const MODE_OPTIONS = [
  { value: 'read-only', name: 'read-only' },
  { value: 'workspace-write', name: 'workspace-write' },
  { value: 'danger-full-access', name: 'danger-full-access' },
]

function harness(overrides = {}) {
  const calls = { prompts: [], cancels: [], creates: [], modeReads: [], modeWrites: [] }
  const deps = {
    bindings: new Bindings(),
    now: () => NOW,
    status: () => 'одна цель',
    sessions: async () => items,
    workspaces: () => [
      { name: 'harness', path: '/workspace/deepseek-harness', sessions: 2 },
      { name: 'site', path: '/workspace/projects/site', sessions: 1 },
    ],
    workspaceOf,
    create: async (cwd) => { calls.creates.push(cwd); return 'cccccccc-3333' },
    prompt: async (sessionId, text) => { calls.prompts.push({ sessionId, text }) },
    cancel: (sessionId) => { calls.cancels.push(sessionId) },
    modes: async (sessionId) => { calls.modeReads.push(sessionId); return { current: 'workspace-write', options: MODE_OPTIONS } },
    setMode: async (sessionId, preset) => { calls.modeWrites.push({ sessionId, preset }); return { current: preset, options: MODE_OPTIONS } },
    ...overrides,
  }
  return { deps, calls }
}

const say = (deps, text, extra = {}) => handleMessage({ text, chatId: '7', ...extra }, deps)

test('the sessions screen is buttons, one per session, plus a way to start one', () => {
  const deps = harness().deps
  const screen = sessionsScreen(items, deps, NOW)
  assert.match(screen.text, /Выбери сессию/)
  assert.equal(screen.keyboard.length, 3, 'two sessions and the new-session button')
  assert.equal(screen.keyboard[0][0].callback_data, 'pick:aaaaaaaa-1111')
  assert.match(screen.keyboard[0][0].text, /▶ harness · Fix the login bug · только что/)
  assert.equal(screen.keyboard[2][0].callback_data, 'new')
  const empty = sessionsScreen([], deps, NOW)
  assert.match(empty.text, /Напиши задачу/)
  assert.equal(empty.keyboard[0][0].callback_data, 'new')
})

test('a button label stays inside the 64 characters Telegram allows', () => {
  const deps = harness().deps
  const long = { sessionId: 'x'.repeat(36), updatedAt: NOW, running: true, cwd: '/workspace/deepseek-harness', title: 'з'.repeat(200) }
  assert.ok(sessionLabel(long, deps, NOW).length <= 64)
})

test('the projects screen starts a session in the tapped project', () => {
  const screen = workspacesScreen([{ name: 'harness', path: '/w/h', sessions: 2 }, { path: '/w/site' }])
  assert.match(screen.keyboard[0][0].text, /📁 harness · 2/)
  assert.equal(screen.keyboard[0][0].callback_data, 'new:0')
  assert.match(screen.keyboard[1][0].text, /📁 site/)
  assert.match(workspacesScreen([]).text, /Напиши задачу/)
})

test('/sessions then /use still works for muscle memory', async () => {
  const { deps, calls } = harness()
  await say(deps, '/sessions')
  assert.match(await say(deps, '/use 2'), /Пиши текст/)
  assert.equal(await say(deps, 'сделай ревью'), undefined, 'a forwarded message needs no reply')
  assert.deepEqual(calls.prompts, [{ sessionId: 'bbbbbbbb-2222', text: 'сделай ревью' }])
})

test('/use without a listing, or with a number nobody listed, says what to do', async () => {
  const { deps, calls } = harness()
  assert.match((await say(deps, '/use 1')).text, /нет в последнем списке/)
  assert.match((await say(deps, '/use')).text, /кнопкой/)
  await say(deps, '/sessions')
  assert.match((await say(deps, '/use 99')).text, /нет в последнем списке/)
  assert.deepEqual(calls.prompts, [])
})

test('writing inside a session thread needs no binding at all', async () => {
  const { deps, calls } = harness()
  assert.equal(await handleMessage({ text: 'продолжай', chatId: '7', threadId: 42, threadSession: 'aaaaaaaa-1111' }, deps), undefined)
  assert.deepEqual(calls.prompts, [{ sessionId: 'aaaaaaaa-1111', text: 'продолжай' }])
})

test('a thread binding wins over the chat binding', async () => {
  const { deps, calls } = harness()
  await say(deps, '/sessions')
  await say(deps, '/use 2')
  await handleMessage({ text: 'в тред', chatId: '7', threadId: 42, threadSession: 'aaaaaaaa-1111' }, deps)
  assert.equal(calls.prompts[0].sessionId, 'aaaaaaaa-1111')
})

test('plain text with nothing chosen opens a session and starts, without a ritual', async () => {
  const { deps, calls } = harness()
  assert.equal(await say(deps, 'почини вход'), undefined, 'no lecture, no menu — it just works')
  assert.deepEqual(calls.creates, [undefined])
  assert.deepEqual(calls.prompts, [{ sessionId: 'cccccccc-3333', text: 'почини вход' }])
  // and the next message continues that same session rather than opening another
  await say(deps, 'и тесты')
  assert.equal(calls.creates.length, 1)
  assert.deepEqual(calls.prompts.at(-1), { sessionId: 'cccccccc-3333', text: 'и тесты' })
})

test('tapping a session binds it; tapping "new" opens one; an unknown button says so', async () => {
  const { deps, calls } = harness()
  const picked = await handleCallback({ data: 'pick:bbbbbbbb-2222', chatId: '7', messageId: 5 }, deps)
  assert.equal(picked.answer, 'Выбрано')
  assert.equal(picked.edit, true)
  assert.match(picked.text, /Пишу в/)
  assert.equal(await say(deps, 'давай'), undefined)
  assert.deepEqual(calls.prompts, [{ sessionId: 'bbbbbbbb-2222', text: 'давай' }])

  const opened = await handleCallback({ data: 'new:1', chatId: '7', messageId: 5 }, deps)
  assert.equal(opened.answer, 'Сессия открыта')
  assert.equal(calls.creates.at(-1), '/workspace/projects/site')

  const listed = await handleCallback({ data: 'list', chatId: '7', messageId: 5 }, deps)
  assert.equal(listed.keyboard[0][0].callback_data, 'pick:aaaaaaaa-1111')
  assert.equal((await handleCallback({ data: 'нечто', chatId: '7' }, deps)).answer, 'Не понял кнопку')
  assert.equal((await handleCallback({ data: 'new:99', chatId: '7' }, deps)).answer, 'Проект не найден')
})

test('/new takes a workspace by number, by name or by path, and binds the chat', async () => {
  const { deps, calls } = harness()
  assert.match(await say(deps, '/new'), /Сессия открыта/)
  assert.deepEqual(calls.creates, [undefined], 'bare /new uses where the harness stands')
  assert.equal(await say(deps, 'поехали'), undefined)
  assert.deepEqual(calls.prompts, [{ sessionId: 'cccccccc-3333', text: 'поехали' }])
  await say(deps, '/new 2')
  assert.equal(calls.creates[1], '/workspace/projects/site', 'by number from /workspaces')
  await say(deps, '/new HARNESS')
  assert.equal(calls.creates[2], '/workspace/deepseek-harness', 'by name, case-insensitively')
  await say(deps, '/new /tmp/elsewhere')
  assert.equal(calls.creates[3], '/tmp/elsewhere', 'an absolute path is taken as is')
  assert.match((await say(deps, '/new нетакого')).text, /Не нашёл проект/)
  assert.equal(calls.creates.length, 4, 'an unknown name creates nothing')
})

test('/stop cancels the bound session and says so when there is none', async () => {
  const { deps, calls } = harness()
  assert.match(await say(deps, '/stop'), /Нечего прерывать/)
  await say(deps, '/sessions')
  await say(deps, '/use 1')
  assert.match(await say(deps, '/stop'), /Прервал/)
  assert.deepEqual(calls.cancels, ['aaaaaaaa-1111'])
})

test('/start and /help teach the whole grammar; an unknown command does too', async () => {
  const { deps } = harness()
  const start = await say(deps, '/start')
  assert.match(start.text, /Напиши задачу/)
  assert.match(start.text, /свой тред/)
  assert.equal(start.keyboard[0][0].callback_data, 'list')
  assert.match((await say(deps, '/help')).text, /\/sessions/)
  assert.match((await say(deps, '/nope')).text, /Не знаю команду \/nope/)
  assert.equal(await say(deps, '/ID'), 'chat id: 7')
  assert.equal(await say(deps, '/status'), 'одна цель')
})

test('commands survive the @botname suffix and empty text', async () => {
  const { deps } = harness()
  assert.match((await say(deps, '/sessions@dsharnebot')).text, /Выбери сессию/)
  assert.equal(await say(deps, '   '), undefined)
})


test('the access mode is a screen of presets with the live one marked', () => {
  const screen = modeScreen({ current: 'workspace-write', options: MODE_OPTIONS })
  assert.match(screen.text, /Режим доступа: ✍️ Запись в проекте/)
  assert.match(screen.text, /● ✍️ Запись в проекте/)
  assert.match(screen.text, /○ 🔓 Полный доступ/)
  assert.equal(screen.keyboard.length, 3)
  assert.equal(screen.keyboard[2][0].callback_data, 'mode:danger-full-access')
  for (const row of screen.keyboard) assert.ok(row[0].text.length <= 64)
})

test('/mode without a session says whose setting it is', async () => {
  const { deps, calls } = harness()
  const answer = await say(deps, '/mode')
  assert.match(answer.text, /Сначала выбери сессию/)
  assert.deepEqual(calls.modeReads, [])
})

test('/mode inside a thread shows that session\'s mode', async () => {
  const { deps, calls } = harness()
  const answer = await say(deps, '/mode', { threadId: 5, threadSession: 'aaaaaaaa-1111' })
  assert.match(answer.text, /Режим доступа/)
  assert.deepEqual(calls.modeReads, ['aaaaaaaa-1111'])
})

test('/mode full switches without opening the screen first', async () => {
  const { deps, calls } = harness()
  const answer = await say(deps, '/mode full', { threadId: 5, threadSession: 'aaaaaaaa-1111' })
  assert.deepEqual(calls.modeWrites, [{ sessionId: 'aaaaaaaa-1111', preset: 'danger-full-access' }])
  assert.match(answer.text, /Режим доступа: 🔓 Полный доступ/)
})

test('a word that names no preset shows the screen instead of guessing', async () => {
  const { deps, calls } = harness()
  const answer = await say(deps, '/mode ну какой-нибудь', { threadId: 5, threadSession: 'aaaaaaaa-1111' })
  assert.deepEqual(calls.modeWrites, [])
  assert.match(answer.text, /Режим доступа/)
})

test('the shorthand knows both the raw names and how a human says them', () => {
  assert.equal(matchMode(MODE_OPTIONS, 'read-only'), 'read-only')
  assert.equal(matchMode(MODE_OPTIONS, 'чтение'), 'read-only')
  assert.equal(matchMode(MODE_OPTIONS, 'полный'), 'danger-full-access')
  assert.equal(matchMode(MODE_OPTIONS, 'work'), 'workspace-write')
  assert.equal(matchMode(MODE_OPTIONS, 'w'), undefined, 'одна буква — это не выбор')
  assert.equal(matchMode(MODE_OPTIONS, ''), undefined)
})

test('tapping a mode button switches and redraws the same screen', async () => {
  const { deps, calls } = harness()
  const opened = await handleCallback({ data: 'mode', chatId: '7', threadId: 5, threadSession: 'aaaaaaaa-1111' }, deps)
  assert.equal(opened.edit, true)
  assert.match(opened.text, /Режим доступа/)
  const switched = await handleCallback({ data: 'mode:read-only', chatId: '7', threadId: 5, threadSession: 'aaaaaaaa-1111' }, deps)
  assert.deepEqual(calls.modeWrites, [{ sessionId: 'aaaaaaaa-1111', preset: 'read-only' }])
  assert.equal(switched.answer, 'Режим переключён')
  assert.match(switched.text, /● 👀 Только чтение/)
})

test('the home keyboard offers the mode switch', async () => {
  const { deps } = harness()
  const start = await say(deps, '/start')
  assert.ok(start.keyboard.flat().some((button) => button.callback_data === 'mode'))
})
