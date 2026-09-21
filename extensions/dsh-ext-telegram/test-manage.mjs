// Management-surface tests (destinations, routes, panel markup).
// Run inside the dsh container:
//   node --test /data/dsh/profiles/web/node_modules/dsh-ext-telegram/test-manage.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chatsFromUpdates, envDestination, normalize, redact, remove, slugify, tokenRef, upsert,
} from './destinations.js'
import { createHandlers, dispatch } from './routes.js'
import { panelRows } from './panel.js'

const TOKEN = '123456:AAHfakefakefakefakefakefake'

test('ids and credential references are derived, stable and unique', () => {
  assert.equal(slugify('Мой бот'), 'bot')
  assert.equal(slugify('Ops alerts'), 'ops-alerts')
  assert.equal(slugify('Ops alerts', ['ops-alerts']), 'ops-alerts-2')
  assert.equal(tokenRef('ops-alerts'), 'TELEGRAM_BOT_TOKEN_OPS_ALERTS')
})

test('a record is validated, not trusted', () => {
  const record = normalize({ label: ' Ops ', chatId: '-1001234567890', mode: 'summary', tools: 'nonsense' })
  assert.deepEqual(record, { id: undefined, label: 'Ops', chatId: '-1001234567890', mode: 'summary', tools: 'compact', topics: true, enabled: true, minRunSeconds: 45 })
  assert.throws(() => normalize({ label: '', chatId: '1' }), /name is required/)
  assert.throws(() => normalize({ label: 'x', chatId: 'not a number' }), /chat id must be a number/)
  // an update keeps what it does not mention
  assert.equal(normalize({ enabled: false }, { label: 'Ops', chatId: '5', mode: 'summary' }).mode, 'summary')
})

test('the browser never sees a token, only whether one exists', () => {
  const view = redact({ id: 'a', label: 'A', chatId: '1', mode: 'stream', tools: 'compact', topics: true, enabled: true, minRunSeconds: 45, token: 'SECRET' }, { hasToken: true })
  assert.equal(JSON.stringify(view).includes('SECRET'), false)
  assert.equal(view.hasToken, true)
})

test('list operations are immutable and keep order', () => {
  const a = { id: 'a', label: 'A' }
  const b = { id: 'b', label: 'B' }
  const list = upsert(upsert([], a), b)
  assert.deepEqual(list.map((d) => d.id), ['a', 'b'])
  const updated = upsert(list, { id: 'a', label: 'A2' })
  assert.equal(updated[0].label, 'A2')
  assert.equal(list[0].label, 'A', 'the input list is not mutated')
  assert.deepEqual(remove(updated, 'a').map((d) => d.id), ['b'])
})

test('chats are collected from every update shape, newest first', () => {
  const chats = chatsFromUpdates([
    { message: { chat: { id: 1, type: 'private', first_name: 'Roman' } } },
    { message: { chat: { id: 1, type: 'private', first_name: 'Roman' } } },
    { my_chat_member: { chat: { id: -100, type: 'supergroup', title: 'Ops' } } },
  ])
  assert.deepEqual(chats, [
    { id: '-100', title: 'Ops', type: 'supergroup' },
    { id: '1', title: 'Roman', type: 'private' },
  ])
  assert.deepEqual(chatsFromUpdates(undefined), [])
})

test('an environment-configured destination is offered read-only', () => {
  assert.equal(envDestination({}), undefined)
  assert.equal(envDestination({ TELEGRAM_BOT_TOKEN: 't' }), undefined)
  const d = envDestination({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '5' })
  assert.equal(d.id, 'env')
  assert.equal(d.readOnly, true)
})

/** A harness for the route handlers with in-memory stores and a fake Bot API. */
function harness(options = {}) {
  const state = { list: options.list ?? [], tokens: new Map(options.tokens ?? []), reloads: 0, calls: [] }
  const handlers = createHandlers({
    list: async () => state.list,
    save: async (list) => { state.list = list },
    getToken: async (ref) => state.tokens.get(ref),
    setToken: async (ref, value) => { state.tokens.set(ref, value) },
    clearToken: async (ref) => { state.tokens.delete(ref) },
    api: async (token, method, payload) => {
      state.calls.push({ token, method, payload })
      if (options.apiFails) throw new Error('Unauthorized')
      if (method === 'getMe') return { username: 'test_bot', first_name: 'Test' }
      if (method === 'getUpdates') return [{ message: { chat: { id: 7, type: 'private', first_name: 'Roman' } } }]
      return {}
    },
    envDestination: () => undefined,
    reload: () => { state.reloads++ },
  })
  return { state, handlers }
}

const body = async (response) => response.json()

test('adding a bot validates the token, stores it out of settings, and reloads', async () => {
  const { state, handlers } = harness()
  const answer = await body(await handlers.save({ label: 'Ops', token: TOKEN, chatId: '7' }))
  assert.equal(answer.ok, true)
  assert.equal(answer.destination.id, 'ops')
  assert.equal(JSON.stringify(answer).includes(TOKEN), false, 'the token never travels back')
  assert.equal(state.tokens.get('TELEGRAM_BOT_TOKEN_OPS'), TOKEN)
  assert.equal(JSON.stringify(state.list).includes(TOKEN), false, 'the token is not written into settings')
  assert.equal(state.reloads, 1)
  assert.equal(state.calls[0].method, 'getMe')
})

test('a bad token is refused before anything is stored', async () => {
  const { state, handlers } = harness({ apiFails: true })
  assert.match((await body(await handlers.save({ label: 'Ops', token: TOKEN, chatId: '7' }))).error, /Unauthorized/)
  assert.equal(state.list.length, 0)
  assert.equal(state.tokens.size, 0)
  assert.match((await body(await handlers.validate({ token: 'nope' }))).error, /does not look like a bot token/)
})

test('adding without a token is refused; updating without one keeps the stored token', async () => {
  const { state, handlers } = harness()
  assert.match((await body(await handlers.save({ label: 'Ops', chatId: '7' }))).error, /token is required/)
  await handlers.save({ label: 'Ops', token: TOKEN, chatId: '7' })
  const updated = await body(await handlers.save({ id: 'ops', enabled: false }))
  assert.equal(updated.ok, true)
  assert.equal(state.list[0].enabled, false)
  assert.equal(state.list[0].chatId, '7', 'untouched fields survive')
  assert.equal(state.tokens.get('TELEGRAM_BOT_TOKEN_OPS'), TOKEN)
})

test('discover lists chats and explains an empty answer', async () => {
  const { handlers } = harness({ list: [{ id: 'ops', label: 'Ops', chatId: '7' }], tokens: [['TELEGRAM_BOT_TOKEN_OPS', TOKEN]] })
  const found = await body(await handlers.discover({ id: 'ops' }))
  assert.deepEqual(found.chats, [{ id: '7', title: 'Roman', type: 'private' }])
  assert.equal(found.hint, undefined)
  const missing = await body(await handlers.discover({ id: 'nope' }))
  assert.equal(missing.error, 'no such bot')
})

test('discover works from a raw token, so the add form can look before saving', async () => {
  // The chat id is required to save, so requiring a saved bot to discover a
  // chat would close the circle the add form has to walk through.
  const { state, handlers } = harness()
  const found = await body(await handlers.discover({ token: TOKEN }))
  assert.deepEqual(found.chats, [{ id: '7', title: 'Roman', type: 'private' }])
  assert.equal(state.list.length, 0, 'looking stores nothing')
  assert.equal(state.calls[0].method, 'getUpdates')
  assert.match((await body(await handlers.discover({ token: 'nope' }))).error, /does not look like a bot token/)
})

test('an empty discover answer says why, in the words the operator needs', async () => {
  const { handlers } = harness()
  const empty = createHandlers({
    list: async () => [], save: async () => {}, getToken: async () => TOKEN,
    setToken: async () => {}, clearToken: async () => {}, reload: () => {},
    api: async () => [],
  })
  const answer = await body(await empty.discover({ token: TOKEN }))
  assert.deepEqual(answer.chats, [])
  assert.match(answer.hint, /\/start/)
  assert.ok(handlers)
})

test('a destination without a stored token fails loudly instead of sending nothing', async () => {
  const { handlers } = harness({ list: [{ id: 'ops', label: 'Ops', chatId: '7' }] })
  assert.match((await body(await handlers.test({ id: 'ops' }))).error, /no token stored/)
})

test('removing forgets both the record and the token', async () => {
  const { state, handlers } = harness({ list: [{ id: 'ops', label: 'Ops', chatId: '7' }], tokens: [['TELEGRAM_BOT_TOKEN_OPS', TOKEN]] })
  assert.equal((await body(await handlers.remove({ id: 'ops' }))).ok, true)
  assert.equal(state.list.length, 0)
  assert.equal(state.tokens.size, 0)
})

test('state exposes the roster without secrets, and dispatch guards unknown actions', async () => {
  const { handlers } = harness({ list: [{ id: 'ops', label: 'Ops', chatId: '7', mode: 'stream' }], tokens: [['TELEGRAM_BOT_TOKEN_OPS', TOKEN]] })
  const answer = await body(await handlers.state())
  assert.equal(answer.destinations[0].hasToken, true)
  assert.equal(JSON.stringify(answer).includes(TOKEN), false)
  assert.equal((await (await dispatch(handlers, 'nope', {})).json()).error, 'unknown action')
  const thrown = await dispatch({ boom: () => { throw new Error('kaboom') } }, 'boom', {})
  assert.equal(thrown.status, 500)
  assert.equal((await thrown.json()).error, 'kaboom')
})

test('state reports whether the bot can answer, which a silent /start is about', async () => {
  const { handlers } = harness({ list: [{ id: 'ops', label: 'Ops', chatId: '7' }], tokens: [['TELEGRAM_BOT_TOKEN_OPS', TOKEN]] })
  assert.equal((await body(await handlers.state())).destinations[0].listening, 'off', 'no polling reporter wired means off')
  const withPolling = createHandlers({
    list: async () => [{ id: 'ops', label: 'Ops', chatId: '7' }],
    save: async () => {}, setToken: async () => {}, clearToken: async () => {}, reload: () => {}, api: async () => ({}),
    getToken: async () => TOKEN,
    pollingState: () => 'listening',
  })
  assert.equal((await body(await withPolling.state())).destinations[0].listening, 'listening')
  const noToken = createHandlers({
    list: async () => [{ id: 'ops', label: 'Ops', chatId: '7' }],
    save: async () => {}, setToken: async () => {}, clearToken: async () => {}, reload: () => {}, api: async () => ({}),
    getToken: async () => undefined,
    pollingState: () => 'listening',
  })
  const row = (await body(await noToken.state())).destinations[0]
  assert.equal(row.hasToken, false)
  assert.equal(row.listening, 'no-token')
})

test('a running poller owns discovery, because a second getUpdates would see nothing', async () => {
  const seen = [{ id: '7', title: 'Roman', type: 'private' }]
  let apiCalls = 0
  const handlers = createHandlers({
    list: async () => [{ id: 'ops', label: 'Ops', chatId: '7' }],
    save: async () => {}, setToken: async () => {}, clearToken: async () => {}, reload: () => {},
    getToken: async () => TOKEN,
    api: async () => { apiCalls++; return [] },
    seenChats: (id) => (id === 'ops' ? seen : []),
  })
  const answer = await body(await handlers.discover({ id: 'ops' }))
  assert.deepEqual(answer.chats, seen)
  assert.equal(apiCalls, 0, 'the cache answers instead of asking Telegram again')
  // a token typed into the add form has no listener yet, so that path still asks
  await handlers.discover({ token: TOKEN })
  assert.equal(apiCalls, 1)
})

test('panel rows are well formed and cannot close their own element', () => {
  const rows = panelRows()
  assert.deepEqual(rows.map((r) => r.kind), ['style', 'html', 'script'])
  for (const row of rows) {
    const text = row.text ?? row.html
    assert.doesNotMatch(text, /<\/script/i)
    assert.doesNotMatch(text, /<\/style/i)
  }
  assert.match(rows[1].html, /id="dsh-tg-open"/)
  assert.match(rows[2].text, /\/api\/telegram\//)
  assert.match(rows[2].text, /credentials:'same-origin'/)
})
