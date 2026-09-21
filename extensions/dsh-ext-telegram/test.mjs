// Run inside the dsh container:
//   node --test /data/dsh/profiles/web/node_modules/dsh-ext-telegram/test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  argsDigest, blocksText, completionText, errorText, formatEvent, humanDuration, topicTitle, truncate,
} from './format.js'
import { TelegramClient } from './telegram.js'

const ev = (type, data) => ({ type, seq: 1, data })

test('user asks and assistant answers are broadcast; plugin-authored user events are not', () => {
  assert.deepEqual(
    formatEvent(ev('user/message', { content: [{ type: 'text', text: 'fix the bug' }], source: { kind: 'user' } })),
    { kind: 'user', text: '👤 fix the bug' },
  )
  assert.equal(formatEvent(ev('user/message', { content: [{ type: 'text', text: 'ctx' }], source: { kind: 'plugin' } })), undefined)
  assert.equal(formatEvent(ev('user/message', { content: [], source: { kind: 'user' } })), undefined)
  assert.deepEqual(
    formatEvent(ev('assistant/message', { message: { content: [{ type: 'text', text: 'done' }] } })),
    { kind: 'assistant', text: '🤖 done' },
  )
})

test('tool calls are one line and can be switched off', () => {
  const call = ev('tool/call', { name: 'read', arguments: { path: 'src/auth.ts', offset: 1 } })
  assert.deepEqual(formatEvent(call), { kind: 'tool', text: '⚙️ read  src/auth.ts' })
  assert.equal(formatEvent(call, { tools: 'off' }), undefined)
  assert.equal(formatEvent(ev('tool/call', { name: 'bash', arguments: { command: 'pnpm  test\n--all' } })).text, '⚙️ bash  pnpm test --all')
  assert.equal(formatEvent(ev('tool/call', { name: 'x', arguments: {} })).text, '⚙️ x')
})

test('approvals and titles always come through, unknown events never do', () => {
  const approval = formatEvent(ev('approval/asked', { toolName: 'bash', reason: 'writes outside the workspace' }))
  assert.equal(approval.kind, 'approval')
  assert.match(approval.text, /Ждёт твоего решения: bash/)
  assert.match(approval.text, /writes outside the workspace/)
  assert.equal(formatEvent(ev('session/title', { title: 'Fix login' })).kind, 'title')
  assert.equal(formatEvent(ev('turn/start', {})), undefined)
  assert.equal(formatEvent(undefined), undefined)
})

test('long text is truncated with an ellipsis and images are marked', () => {
  assert.equal(truncate('x'.repeat(10), 5), 'xxxx…')
  assert.equal(blocksText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'a[image]b')
  // '🤖 ' is three UTF-16 units, then 3499 characters and the ellipsis
  assert.equal(formatEvent(ev('assistant/message', { content: [{ type: 'text', text: 'y'.repeat(5000) }] })).text.length, 3503)
})

test('topic titles and durations read like a human wrote them', () => {
  assert.equal(topicTitle('  fix   the login bug\n'), 'fix the login bug')
  assert.equal(topicTitle(''), 'dsh session')
  assert.equal(topicTitle('z'.repeat(200)).length, 96)
  assert.equal(humanDuration(45_000), '45s')
  assert.equal(humanDuration(120_000), '2m')
  assert.equal(humanDuration(95_000), '1m 35s')
  assert.match(completionText(90_000, { total: 12_000, cacheRead: 9000, billedInput: 10_000 }), /Готово за 1m 30s · 12k токенов, 90% из кэша/)
  assert.equal(completionText(50_000, undefined), '✅ Готово за 50s')
  assert.match(errorText(new Error('boom')), /⚠️ Ошибка: boom/)
})

function fakeFetch(calls, behaviour = () => ({ ok: true, result: { message_thread_id: 77 } })) {
  return async (url, init) => {
    const method = String(url).split('/').pop()
    const payload = JSON.parse(init.body)
    calls.push({ method, payload })
    const body = behaviour(method, payload)
    return { status: body.ok ? 200 : 400, json: async () => body }
  }
}

test('client opens a topic and posts into it, serially and rate-limited', async () => {
  const calls = []
  const client = new TelegramClient({ token: 't', chatId: '42', minIntervalMs: 0, fetchImpl: fakeFetch(calls) })
  const thread = await client.createTopic('Fix login')
  assert.equal(thread, 77)
  assert.equal(calls[0].method, 'createForumTopic')
  assert.deepEqual(calls[0].payload, { chat_id: '42', name: 'Fix login' })
  client.post('one', 77)
  client.post('two', 77)
  await client.drain()
  assert.deepEqual(calls.slice(1).map((c) => c.payload.text), ['one', 'two'])
  assert.equal(calls[1].payload.message_thread_id, 77)
  assert.equal(calls[1].payload.link_preview_options.is_disabled, true)
  assert.equal(client.sent, 2)
})

test('a chat without topics reports it instead of throwing, and sends stay unthreaded', async () => {
  const errors = []
  const client = new TelegramClient({
    token: 't', chatId: '42', minIntervalMs: 0,
    fetchImpl: fakeFetch([], (method) => method === 'createForumTopic'
      ? { ok: false, description: 'Bad Request: the chat is not a forum' }
      : { ok: true, result: {} }),
    onError: (e) => errors.push(e.message),
  })
  assert.equal(await client.createTopic('x'), undefined)
  assert.match(errors[0], /not a forum/)
  client.post('plain')
  await client.drain()
  assert.equal(client.sent, 1)
})

test('a failing send is reported and the outbox keeps draining', async () => {
  const errors = []
  let first = true
  const client = new TelegramClient({
    token: 't', chatId: '42', minIntervalMs: 0,
    fetchImpl: fakeFetch([], () => {
      if (first) { first = false; return { ok: false, description: 'thread not found' } }
      return { ok: true, result: {} }
    }),
    onError: (e) => errors.push(e.message),
  })
  client.post('a')
  client.post('b')
  await client.drain()
  assert.match(errors[0], /thread not found/)
  assert.equal(client.sent, 1, 'the one that failed is reported, the next still goes')
  assert.equal(client.queue.length, 0)
})

test('the outbox is bounded while a send is in flight', async () => {
  // A hung request parks the loop, which is the only state in which a backlog
  // can build at all — that is where the bound has to hold.
  let release
  const inFlight = new Promise((resolve) => { release = resolve })
  const client = new TelegramClient({
    token: 't', chatId: '42', minIntervalMs: 0, maxQueue: 2,
    fetchImpl: async () => {
      await inFlight
      return { status: 200, json: async () => ({ ok: true, result: {} }) }
    },
  })
  client.post('first')          // starts the loop and hangs in fetch
  client.post('a')              // queued
  client.post('b')              // queued, now at the bound
  client.post('c')              // dropped
  assert.equal(client.queue.length, 2)
  assert.equal(client.dropped, 1, 'past the bound messages are dropped, not accumulated')
  release()
  await client.drain()
  assert.equal(client.sent, 3)
  assert.equal(client.queue.length, 0)
})
