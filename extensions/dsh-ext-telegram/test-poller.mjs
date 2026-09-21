// Poller tests. Run inside the dsh container:
//   node --test /data/dsh/profiles/web/node_modules/dsh-ext-telegram/test-poller.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatOf, replyFor, UpdatePoller } from './poller.js'

const message = (id, text, extra = {}) => ({
  update_id: id,
  message: { text, message_thread_id: extra.threadId, chat: { id: extra.chatId ?? 7, type: 'private', first_name: 'Roman' } },
})

test('the bot answers the commands a person actually types', () => {
  const start = replyFor('/start', { chatId: '7', configured: true })
  assert.match(start, /chat id: 7/)
  assert.match(start, /треды сессий/)
  assert.match(replyFor('/start', { chatId: '7', configured: false }), /панель/)
  assert.equal(replyFor('/id', { chatId: '-100' }), 'chat id: -100')
  assert.equal(replyFor('/status', { chatId: '7', status: 'две сессии' }), 'две сессии')
  assert.match(replyFor('/help', { chatId: '7' }), /\/id/)
})

test('command parsing tolerates the shapes Telegram delivers', () => {
  assert.ok(replyFor('/start@my_bot', { chatId: '7' }))
  assert.ok(replyFor('  /START  ', { chatId: '7' }))
  assert.ok(replyFor('/start deep link payload', { chatId: '7' }))
  assert.equal(replyFor('просто сообщение', { chatId: '7' }), undefined)
  assert.equal(replyFor(undefined, { chatId: '7' }), undefined)
})

test('a chat is extracted from every update shape, with a readable name', () => {
  assert.deepEqual(chatOf(message(1, 'hi')), { id: '7', title: 'Roman', type: 'private', text: 'hi', threadId: undefined })
  assert.equal(chatOf({ my_chat_member: { chat: { id: -100, type: 'supergroup', title: 'Ops' } } }).title, 'Ops')
  assert.equal(chatOf({}), undefined)
})

/** An api stub returning queued batches, then nothing. */
function stubApi(batches) {
  const calls = []
  return {
    calls,
    api: async (method, payload) => {
      calls.push({ method, payload })
      return batches.shift() ?? []
    },
  }
}

test('offset advances past handled updates so nothing repeats', async () => {
  const { api, calls } = stubApi([[message(10, 'hi'), message(11, '/id')], []])
  const poller = new UpdatePoller({ api })
  await poller.round()
  assert.equal(calls[0].payload.offset, undefined, 'the first round asks for whatever is pending')
  assert.equal(poller.offset, 12)
  await poller.round()
  assert.equal(calls[1].payload.offset, 12)
})

test('chats are remembered and commands answered', async () => {
  const { api } = stubApi([[message(1, '/start'), message(2, 'привет'), message(3, '/id', { chatId: -100 })]])
  const chats = []
  const replies = []
  const poller = new UpdatePoller({
    api,
    onChat: (chat) => chats.push(chat.id),
    reply: (chatId, text) => replies.push({ chatId, text }),
    facts: (chatId) => ({ chatId, configured: true }),
  })
  await poller.round()
  assert.deepEqual(chats, ['7', '7', '-100'])
  assert.deepEqual(replies.map((r) => r.chatId), ['7', '-100'], 'only commands get an answer')
  assert.match(replies[1].text, /chat id: -100/)
})

test('a reply goes back into the thread it came from', async () => {
  const { api } = stubApi([[message(1, '/id', { threadId: 42 })]])
  const replies = []
  const poller = new UpdatePoller({ api, reply: (chatId, text, threadId) => replies.push(threadId), facts: (chatId) => ({ chatId }) })
  await poller.round()
  assert.deepEqual(replies, [42])
})

test('a competing consumer stops the loop instead of fighting it', async () => {
  const errors = []
  const poller = new UpdatePoller({
    api: async () => { throw new Error('Conflict: terminated by other getUpdates request') },
    onError: (e) => errors.push(e.message),
    sleep: async () => {},
  })
  await poller.run()
  assert.equal(poller.conflict, true)
  assert.match(errors[0], /another process is already receiving/)
})

test('an ordinary failure backs off and keeps going until stopped', async () => {
  let attempts = 0
  const waits = []
  const poller = new UpdatePoller({
    api: async () => {
      attempts++
      if (attempts <= 2) throw new Error('network down')
      poller.stop()
      return []
    },
    onError: () => {},
    sleep: async (ms) => { waits.push(ms) },
  })
  await poller.run()
  assert.deepEqual(waits, [1000, 2000], 'the wait doubles')
  assert.equal(poller.conflict, false)
  assert.equal(attempts, 3)
})
