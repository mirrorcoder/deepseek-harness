// Poller tests. Run inside the dsh container:
//   node --test /data/dsh/profiles/web/node_modules/dsh-ext-telegram/test-poller.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callbackOf, chatOf, UpdatePoller } from './poller.js'

const message = (id, text, extra = {}) => ({
  update_id: id,
  message: { text, message_thread_id: extra.threadId, chat: { id: extra.chatId ?? 7, type: 'private', first_name: 'Roman' } },
})

test('a chat is extracted from every update shape, with a readable name', () => {
  assert.deepEqual(chatOf(message(1, 'hi')), { id: '7', title: 'Roman', type: 'private', text: 'hi', photo: undefined, threadId: undefined })
  assert.equal(chatOf({ my_chat_member: { chat: { id: -100, type: 'supergroup', title: 'Ops' } } }).title, 'Ops')
  assert.equal(chatOf({}), undefined)
})

test('a photo arrives as its largest size, with the caption as the text', () => {
  const photo = chatOf({
    message: {
      caption: 'что тут не так?',
      photo: [{ file_id: 'small' }, { file_id: 'medium' }, { file_id: 'original' }],
      chat: { id: 7, type: 'private', first_name: 'Roman' },
    },
  })
  assert.equal(photo.photo, 'original', 'the thumbnail is useless to a vision model')
  assert.equal(photo.text, 'что тут не так?')
  // an image sent as a file counts too; other documents do not
  assert.equal(chatOf({ message: { document: { file_id: 'doc', mime_type: 'image/png' }, chat: { id: 7, type: 'private' } } }).photo, 'doc')
  assert.equal(chatOf({ message: { document: { file_id: 'doc', mime_type: 'application/pdf' }, chat: { id: 7, type: 'private' } } }).photo, undefined)
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

test('every chat is remembered, and only an answered message is replied to', async () => {
  const { api } = stubApi([[message(1, '/start'), message(2, 'forwarded'), message(3, '/id', { chatId: -100 })]])
  const chats = []
  const replies = []
  const poller = new UpdatePoller({
    api,
    onChat: (chat) => chats.push(chat.id),
    reply: (chatId, text) => replies.push({ chatId, text }),
    // the grammar lives in control.js; here it is just "answer or stay silent"
    onMessage: async (chat) => (chat.text.startsWith('/') ? `answer to ${chat.text}` : undefined),
  })
  await poller.round()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(chats, ['7', '7', '-100'])
  assert.deepEqual(replies.map((r) => r.chatId), ['7', '-100'], 'a forwarded message gets no reply')
  assert.match(replies[1].text, /answer to \/id/)
})

test('a slow answer does not stall update consumption', async () => {
  const { api, calls } = stubApi([[message(1, '/slow')], []])
  let release
  const poller = new UpdatePoller({
    api,
    onMessage: () => new Promise((resolve) => { release = () => resolve('done') }),
  })
  await poller.round()
  await poller.round()
  assert.equal(calls.length, 2, 'the next round ran while the answer was still pending')
  release()
})

test('a reply goes back into the thread it came from', async () => {
  const { api } = stubApi([[message(1, '/id', { threadId: 42 })]])
  const replies = []
  const poller = new UpdatePoller({ api, reply: (chatId, text, threadId) => replies.push(threadId), onMessage: async () => 'ok' })
  await poller.round()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(replies, [42])
})

test('a tapped button is delivered as a callback, not as a message', async () => {
  const tap = { update_id: 5, callback_query: { id: 'q1', data: 'pick:abc', message: { message_id: 9, message_thread_id: 42, chat: { id: 7 } } } }
  assert.deepEqual(callbackOf(tap), { id: 'q1', data: 'pick:abc', chatId: '7', threadId: 42, messageId: 9 })
  assert.equal(callbackOf({ message: { chat: { id: 1 } } }), undefined)

  const { api } = stubApi([[tap]])
  const taps = []
  const messages = []
  const poller = new UpdatePoller({ api, onCallback: (t) => { taps.push(t.data) }, onMessage: async (c) => { messages.push(c); return undefined } })
  await poller.round()
  assert.deepEqual(taps, ['pick:abc'])
  assert.deepEqual(messages, [], 'a tap is not also treated as text')
  assert.equal(poller.offset, 6)
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
