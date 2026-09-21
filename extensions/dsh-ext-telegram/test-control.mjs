// Remote-control tests. Run inside the dsh container:
//   node --test /data/dsh/profiles/web/node_modules/dsh-ext-telegram/test-control.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Bindings, formatSessions, formatWorkspaces, handleMessage } from './control.js'
import { workspaceOf } from './topics.js'

const NOW = 1_700_000_000_000
const items = [
  { sessionId: 'aaaaaaaa-1111', updatedAt: NOW - 30_000, running: true, blank: false, cwd: '/workspace/deepseek-harness', title: 'Fix the login bug' },
  { sessionId: 'bbbbbbbb-2222', updatedAt: NOW - 3 * 3_600_000, running: false, blank: false, cwd: '/workspace/projects/site' },
]

function harness(overrides = {}) {
  const calls = { prompts: [], cancels: [], creates: [] }
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
    ...overrides,
  }
  return { deps, calls }
}

const say = (deps, text, extra = {}) => handleMessage({ text, chatId: '7', ...extra }, deps)

test('the session list groups by project, numbers continuously and marks the running one', () => {
  const workspaces = [
    { name: 'harness', path: '/workspace/deepseek-harness' },
    { name: 'site', path: '/workspace/projects/site' },
  ]
  const text = formatSessions(items, { now: NOW, workspaces, workspaceOf })
  assert.match(text, /📁 harness\n  1\. ▶ Fix the login bug · только что/)
  assert.match(text, /📁 site\n  2\. · bbbbbbbb · 3 ч назад/)
  assert.match(text, /\/use N/)
  assert.match(formatSessions([]), /Сессий пока нет/)
  // a session outside every registered workspace still shows up, under its own directory
  const orphan = formatSessions([{ sessionId: 'x', updatedAt: NOW, running: false, cwd: '/tmp/scratch' }], { now: NOW, workspaces, workspaceOf })
  assert.match(orphan, /📁 scratch/)
})

test('workspaces list paths and session counts', () => {
  assert.match(formatWorkspaces([{ name: 'harness', path: '/w/h', sessions: 2 }]), /1\. 📁 harness · \/w\/h · сессий: 2/)
  assert.match(formatWorkspaces([{ path: '/w/unnamed' }]), /📁 unnamed/)
  assert.match(formatWorkspaces([]), /Воркспейсов нет/)
})

test('/sessions then /use binds the chat, and plain text then reaches that session', async () => {
  const { deps, calls } = harness()
  await say(deps, '/sessions')
  assert.match(await say(deps, '/use 2'), /сессию 2/)
  assert.equal(await say(deps, 'сделай ревью'), undefined, 'a forwarded message needs no reply')
  assert.deepEqual(calls.prompts, [{ sessionId: 'bbbbbbbb-2222', text: 'сделай ревью' }])
})

test('/use without a listing, or with a number nobody listed, says what to do', async () => {
  const { deps, calls } = harness()
  assert.match(await say(deps, '/use 1'), /Сначала \/sessions/)
  assert.match(await say(deps, '/use'), /Номер сессии/)
  await say(deps, '/sessions')
  assert.match(await say(deps, '/use 99'), /Сначала \/sessions/)
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

test('unbound plain text explains itself instead of vanishing', async () => {
  const { deps, calls } = harness()
  assert.match(await say(deps, 'привет'), /не привязана/)
  assert.deepEqual(calls.prompts, [])
})

test('/new takes a workspace by number, by name or by path, and binds the chat', async () => {
  const { deps, calls } = harness()
  assert.match(await say(deps, '/new'), /Сессия создана/)
  assert.deepEqual(calls.creates, [undefined], 'bare /new uses where the harness stands')
  assert.equal(await say(deps, 'поехали'), undefined)
  assert.deepEqual(calls.prompts, [{ sessionId: 'cccccccc-3333', text: 'поехали' }])
  await say(deps, '/new 2')
  assert.equal(calls.creates[1], '/workspace/projects/site', 'by number from /workspaces')
  await say(deps, '/new HARNESS')
  assert.equal(calls.creates[2], '/workspace/deepseek-harness', 'by name, case-insensitively')
  await say(deps, '/new /tmp/elsewhere')
  assert.equal(calls.creates[3], '/tmp/elsewhere', 'an absolute path is taken as is')
  assert.match(await say(deps, '/new нетакого'), /Не нашёл воркспейс/)
  assert.equal(calls.creates.length, 4, 'an unknown name creates nothing')
})

test('/stop cancels the bound session and says so when there is none', async () => {
  const { deps, calls } = harness()
  assert.match(await say(deps, '/stop'), /не привязана/)
  await say(deps, '/sessions')
  await say(deps, '/use 1')
  assert.match(await say(deps, '/stop'), /Прервал/)
  assert.deepEqual(calls.cancels, ['aaaaaaaa-1111'])
})

test('/start and /help teach the whole grammar; an unknown command does too', async () => {
  const { deps } = harness()
  const start = await say(deps, '/start')
  assert.match(start, /chat id: 7/)
  assert.match(start, /\/workspaces/)
  assert.match(start, /свой тред/)
  assert.match(await say(deps, '/help'), /\/use N/)
  assert.match(await say(deps, '/nope'), /Не знаю команду \/nope/)
  assert.equal(await say(deps, '/ID'), 'chat id: 7')
  assert.equal(await say(deps, '/status'), 'одна цель')
})

test('commands survive the @botname suffix and empty text', async () => {
  const { deps } = harness()
  assert.match(await say(deps, '/sessions@dsharnebot'), /1\./)
  assert.equal(await say(deps, '   '), undefined)
})
