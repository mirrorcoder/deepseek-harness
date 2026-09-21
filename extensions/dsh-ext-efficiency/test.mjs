// Run inside the dsh container:
//   node --test /data/dsh/profiles/web/node_modules/dsh-ext-efficiency/test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalJson, callKey, DedupStore, eligible, pointerText, resultText, sha256, worthReplacing } from './dedup.js'
import { bar, contextReport, fmt } from './report.js'

const config = { minChars: 100, excludeTools: ['ask_user_question'], includeTools: [] }
const big = (marker) => `${marker}`.repeat(200)

test('canonical json makes key order irrelevant but values significant', () => {
  assert.equal(canonicalJson({ a: 1, b: [2, { d: 4, c: 3 }] }), canonicalJson({ b: [2, { c: 3, d: 4 }] , a: 1 }))
  assert.notEqual(canonicalJson({ path: 'a.ts' }), canonicalJson({ path: 'b.ts' }))
  assert.equal(callKey('read', { path: 'a.ts' }), callKey('read', { path: 'a.ts' }))
  assert.notEqual(callKey('read', { path: 'a.ts' }), callKey('write', { path: 'a.ts' }))
})

test('only plain-text results are candidates', () => {
  assert.equal(resultText([{ type: 'text', text: 'ab' }, { type: 'text', text: 'cd' }]), 'abcd')
  assert.equal(resultText([{ type: 'text', text: 'a' }, { type: 'image', attachment: {} }]), undefined)
  assert.equal(resultText([]), undefined)
})

test('eligibility: size floor, tool exclusion, optional allow-list', () => {
  assert.equal(eligible('read', big('x'), config), true)
  assert.equal(eligible('read', 'short', config), false)
  assert.equal(eligible('ask_user_question', big('x'), config), false)
  assert.equal(eligible('read', undefined, config), false)
  assert.equal(eligible('bash', big('x'), { ...config, includeTools: ['read'] }), false)
  assert.equal(eligible('read', big('x'), { ...config, includeTools: ['read'] }), true)
})

test('a byte-identical repeat of the same call is a hit; a changed result is not', () => {
  const store = new DedupStore()
  const text = big('a')
  assert.equal(store.observe('read', { path: 'a.ts' }, text).repeat, false)
  const second = store.observe('read', { path: 'a.ts' }, text)
  assert.equal(second.repeat, true)
  assert.equal(second.entry.call, 1)
  assert.equal(second.digest, sha256(text))
  // same call, output moved on (a log tail): delivered in full
  assert.equal(store.observe('read', { path: 'a.ts' }, `${text}new line`).repeat, false)
  // and the new content becomes the baseline
  assert.equal(store.observe('read', { path: 'a.ts' }, `${text}new line`).repeat, true)
  assert.equal(store.hits, 2)
})

test('different arguments are different calls even with identical output', () => {
  const store = new DedupStore()
  const text = big('a')
  assert.equal(store.observe('read', { path: 'a.ts' }, text).repeat, false)
  assert.equal(store.observe('read', { path: 'b.ts' }, text).repeat, false)
  assert.equal(store.hits, 0)
})

test('the store is bounded and keeps the hot entry', () => {
  const store = new DedupStore(2)
  store.observe('read', { path: 'hot' }, big('h'))
  store.observe('read', { path: 'a' }, big('a'))
  store.observe('read', { path: 'hot' }, big('h')) // refreshes recency
  store.observe('read', { path: 'b' }, big('b'))   // evicts 'a', not 'hot'
  assert.equal(store.entries.size, 2)
  assert.equal(store.observe('read', { path: 'hot' }, big('h')).repeat, true)
  assert.equal(store.observe('read', { path: 'a' }, big('a')).repeat, false)
})

test('the pointer is short, names the earlier call and keeps a preview', () => {
  const store = new DedupStore()
  const text = `first line\nsecond line\n${'z'.repeat(20_000)}`
  store.observe('read', { path: 'a.ts' }, text)
  const hit = store.observe('read', { path: 'a.ts' }, text)
  const pointer = pointerText(hit.entry, hit.digest, 160)
  assert.ok(pointer.length < text.length / 20, 'pointer must be far smaller than the text it replaces')
  assert.match(pointer, /call #1/)
  assert.match(pointer, /sha256:[0-9a-f]{12}/)
  assert.match(pointer, /first line second line/)
  assert.equal(store.countSaving(text.length, pointer.length), text.length - pointer.length)
  assert.equal(store.savedChars, text.length - pointer.length)
})

test('a result barely over the floor is left alone: the pointer would cost more', () => {
  // the failure this test was written for: a 223-character result replaced by a
  // 350-character pointer is a loss, not a saving
  const short = `first line\nsecond line\n${'z'.repeat(200)}`
  const store = new DedupStore()
  store.observe('read', { path: 'a.ts' }, short)
  const hit = store.observe('read', { path: 'a.ts' }, short)
  const pointer = pointerText(hit.entry, hit.digest, 160)
  assert.ok(pointer.length > short.length)
  assert.equal(worthReplacing(short.length, pointer.length, 400), false)
  assert.equal(worthReplacing(20_000, pointer.length, 400), true)
  // exactly at the boundary counts as worth it, one below does not
  assert.equal(worthReplacing(1000, 600, 400), true)
  assert.equal(worthReplacing(1000, 601, 400), false)
})

test('report: occupancy, threshold marker, cache ratio', () => {
  const text = contextReport({
    used: 40_000,
    window: 100_000,
    threshold: 0.8,
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    usage: { input: 1000, output: 500, cacheRead: 9000, cacheWrite: 0, requests: 7 },
    dedup: { hits: 3, savedChars: 8000, calls: 20 },
  })
  assert.match(text, /40\.0k \/ 100\.0k used \(40%\)/)
  assert.match(text, /60\.0k free/)
  assert.match(text, /40\.0k tokens before this session compacts/)
  assert.match(text, /deepseek-official\/deepseek-v4-pro/)
  assert.match(text, /90% cache hits/)
  assert.match(text, /3 of 20 tool results/)
  assert.match(text, /2\.0k tokens not resent/)
})

test('report: no route yet, and a session past the threshold', () => {
  const cold = contextReport({
    threshold: 0.8,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 },
    dedup: { hits: 0, savedChars: 0, calls: 0 },
  })
  assert.match(cold, /unknown until this session routes its first request/)
  const hot = contextReport({
    used: 90_000, window: 100_000, threshold: 0.8,
    usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, requests: 1 },
    dedup: { hits: 0, savedChars: 0, calls: 0 },
  })
  assert.match(hot, /compaction threshold reached/)
})

test('bar marks the threshold and fills to the ratio', () => {
  assert.equal(bar(0, 0.8, 10).length, 10)
  assert.equal(bar(1, 0.8, 10), '##########')
  assert.equal(bar(0, 0.5, 10), '.....|....')
  assert.equal(fmt(1500), '1.5k')
  assert.equal(fmt(2_500_000), '2.50M')
})
