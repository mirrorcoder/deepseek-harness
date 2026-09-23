// The pointer pass. Run inside the dsh container:
//   node --test /data/dsh/profiles/web/node_modules/dsh-ext-prune-pro/test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REGENERABLE, pointerText, sourceOf, textChars, worthPointer } from './pointer.js'

test('a pointer says what was here, how to get it now, and how to get THIS version', () => {
  const text = pointerText({ tool: 'read', source: '/app/main.py', chars: 8400, seq: 42 })
  assert.match(text, /read result for file `\/app\/main\.py`/)
  assert.match(text, /8400 characters/)
  assert.match(text, /CURRENT content/)
  assert.match(text, /session_event_read` at seq 42/)
  assert.match(text, /Do not guess/)
})

test('a pointer without a known source still tells the agent what to do', () => {
  const text = pointerText({ tool: 'read', chars: 5000 })
  assert.match(text, /Run read again/)
  assert.doesNotMatch(text, /undefined/)
})

test('the pointer is worth far less than what it replaces', () => {
  const text = pointerText({ tool: 'read', source: '/app/main.py', chars: 8400, seq: 42 })
  assert.ok(text.length < 400, `указатель должен быть дешёвым, получилось ${text.length}`)
})

test('only recoverable results collapse, and only when they are big', () => {
  assert.equal(worthPointer('read', 5000, 1200), true)
  assert.equal(worthPointer('read', 300, 1200), false, 'короткое чтение дешевле оставить')
  assert.equal(worthPointer('bash', 50000, 1200), false, 'вывод команды нигде больше не лежит')
  assert.equal(worthPointer('edit', 50000, 1200), false)
  assert.equal(REGENERABLE.glob, 'listing')
})

test('the source is read from whichever argument names it', () => {
  assert.equal(sourceOf('{"path":"/a/b.ts"}'), '/a/b.ts')
  assert.equal(sourceOf({ file_path: '/a/c.ts' }), '/a/c.ts')
  assert.equal(sourceOf({ pattern: '**/*.py' }), '**/*.py')
  assert.equal(sourceOf('не json'), undefined)
  assert.equal(sourceOf(undefined), undefined)
  assert.equal(sourceOf({ limit: 5 }), undefined)
  assert.equal(sourceOf({ path: 'x'.repeat(500) }).length, 200, 'длинный путь обрезается')
})

test('glob is named by its pattern, not by the directory it searched', () => {
  // glob takes BOTH; a pointer naming the directory sends the agent back with
  // the pattern lost, and the re-read returns something else entirely.
  assert.equal(sourceOf({ pattern: '**/*.ts', path: '/repo/src' }, 'glob'), '**/*.ts')
  assert.equal(sourceOf({ root: '/opt', path: '/x' }, 'find_projects'), '/opt')
  assert.equal(sourceOf({ path: '/repo/a.ts' }, 'read'), '/repo/a.ts')
})

test('an image result is never collapsed to text', () => {
  assert.equal(REGENERABLE.read_image, undefined)
  assert.equal(worthPointer('read_image', 999_999, 1200), false)
})

test('measuring counts text blocks by code point and ignores the rest', () => {
  assert.equal(textChars([{ type: 'text', text: 'abc' }, { type: 'image' }, { type: 'text', text: 'де' }]), 5)
  assert.equal(textChars([]), 0)
  assert.equal(textChars(undefined), 0)
  // a surrogate pair is one character, not two
  assert.equal(textChars([{ type: 'text', text: '😀' }]), 1)
})

/** A session made of log events, with the surface naming a subset of them. */
function fakeSession(events, surface) {
  return {
    seq: events.length,
    eventAt: (i) => events[i],
    surface: { nodes: surface ?? events.map((_, i) => i) },
  }
}

test('the tool behind a result is found in the LOG, because calls are not on the surface', async () => {
  const { default: ProToolResultPruner } = await import('./index.js').catch(() => ({ default: undefined }))
  if (ProToolResultPruner === undefined) return // peer deps live in the container only
  const events = [
    { type: 'tool/call', data: { callId: 'c1', name: 'read', arguments: '{"file_path":"/a/b.ts"}' } },
    { type: 'assistant/message', data: {} },
    { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'x'.repeat(5000) }] }] } } },
  ]
  // surface holds the message nodes only — exactly the shape that made the pass a no-op
  const session = fakeSession(events, [1, 2])
  const pruner = Object.create(ProToolResultPruner.prototype)
  const calls = pruner._callsOf(session)
  assert.equal(calls.get('c1')?.name, 'read')
})
