// Turn-message tests. Run inside the dsh container:
//   node --test /data/dsh/profiles/web/node_modules/dsh-ext-telegram/test-run-view.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampTail, escapeHtml, renderRun, RunView } from './run-view.js'

test('rendering: the answer, then what the agent is doing, then the footer', () => {
  assert.equal(renderRun({ text: '' }), '<i>⚙️ думаю…</i>')
  assert.equal(renderRun({ text: 'Готово' }), 'Готово\n\n<i>⚙️ думаю…</i>')
  assert.equal(
    renderRun({ text: 'Смотрю', tool: { name: 'read', detail: 'src/auth.ts' } }),
    'Смотрю\n\n<i>⚙️ read · <code>src/auth.ts</code></i>',
  )
  assert.equal(
    renderRun({ text: 'Готово', done: true, footer: '✅ 1m 20s · 12k токенов' }),
    'Готово\n\n<i>✅ 1m 20s · 12k токенов</i>',
  )
  assert.equal(renderRun({ text: 'Готово', done: true }), 'Готово')
})

test('rendering escapes what the model wrote, so markup cannot leak', () => {
  assert.equal(escapeHtml('<b>&</b>'), '&lt;b&gt;&amp;&lt;/b&gt;')
  const body = renderRun({ text: 'ошибка в <div> & <script>', done: true })
  assert.doesNotMatch(body, /<div>/)
  assert.doesNotMatch(body, /<script>/)
  assert.match(renderRun({ text: '', tool: { name: '<b>', detail: '</code>' } }), /&lt;b&gt;/)
})

test('a long answer keeps its tail, which is the part a reader needs', () => {
  const text = `начало${'x'.repeat(5000)}конец`
  const clamped = clampTail(text, 100)
  assert.equal(clamped.length, 100)
  assert.ok(clamped.endsWith('конец'))
  assert.ok(clamped.startsWith('…'))
  assert.equal(clampTail('коротко', 100), 'коротко')
})

/** A client that records what the outbox would have done. */
function fakeClient() {
  const calls = { posts: [], edits: [] }
  return {
    calls,
    postTracked: async (text) => { calls.posts.push(text); return 11 },
    edit: (messageId, text) => { calls.edits.push({ messageId, text }) },
  }
}

test('the placeholder appears once, then edits replace it', async () => {
  const client = fakeClient()
  let now = 0
  const view = new RunView(client, 42, { intervalMs: 100, now: () => now, schedule: () => undefined })
  await view.open()
  assert.deepEqual(client.calls.posts, ['<i>⚙️ думаю…</i>'])
  now = 200
  view.appendText('Привет')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(client.calls.edits.at(-1).messageId, 11)
  assert.match(client.calls.edits.at(-1).text, /Привет/)
  assert.equal(client.calls.posts.length, 1, 'no second message is ever posted')
})

test('redraws are rate-limited, and the final one always goes out', async () => {
  const client = fakeClient()
  let now = 1000
  const scheduled = []
  const view = new RunView(client, undefined, {
    intervalMs: 100,
    now: () => now,
    schedule: (fn) => { scheduled.push(fn); return scheduled.length },
    clear: () => {},
  })
  await view.open()
  view.appendText('a')           // first edit: the interval has passed since 0
  await new Promise((resolve) => setImmediate(resolve))
  const afterFirst = client.calls.edits.length
  view.appendText('b')           // too soon: deferred, not sent
  view.appendText('c')
  assert.equal(client.calls.edits.length, afterFirst, 'a burst does not become a burst of API calls')
  assert.equal(scheduled.length, 1, 'one redraw is scheduled, not one per token')
  await view.finish('✅ 3s')
  const last = client.calls.edits.at(-1).text
  assert.match(last, /abc/, 'everything written in between is in the final body')
  assert.match(last, /✅ 3s/)
})

test('a finished view stops redrawing', async () => {
  const client = fakeClient()
  const view = new RunView(client, undefined, { intervalMs: 0, schedule: () => undefined })
  await view.finish('✅ done')
  const count = client.calls.edits.length
  view.appendText('late')
  assert.equal(client.calls.edits.length, count)
})

test('a post that never lands leaves the view silent instead of throwing', async () => {
  const view = new RunView({ postTracked: async () => undefined, edit: () => { throw new Error('must not edit') } }, undefined, { schedule: () => undefined })
  await view.open()
  view.appendText('x')
  await view.finish('✅')
  assert.equal(view.messageId, undefined)
})
