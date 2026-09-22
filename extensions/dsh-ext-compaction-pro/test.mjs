// Run inside the dsh container:
//   node --test /data/dsh/profiles/web/node_modules/dsh-ext-compaction-pro/test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLedger, renderLedger, splitAtHumanBoundary, isHumanMessage } from './ledger.js'
import { buildInstruction, buildMergeInstruction, resolveTarget, recallPointer, CHECKPOINT_SECTIONS, PRO_DEFAULTS } from './index.js'

const user = (text) => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const call = (name, args) => ({ role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name, arguments: JSON.stringify(args) }] })
const result = () => ({ role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }] })

const span = [
  user('Fix the login bug, do not touch the DB schema'),
  call('read', { path: 'src/auth.ts' }),
  result(),
  call('bash', { command: 'pnpm test -- auth' }),
  result(),
  user('Also add a regression test'),
  call('edit', { file_path: 'src/auth.ts' }),
  result(),
  call('write', { path: 'tests/auth.spec.ts' }),
  result(),
]

test('ledger: paths (deduped, last-touch order), commands, verbatim directives', () => {
  const l = buildLedger(span)
  assert.deepEqual(l.paths.map((p) => p.path), ['src/auth.ts', 'tests/auth.spec.ts'])
  assert.equal(l.paths[0].tool, 'edit')                       // last tool that touched it
  assert.deepEqual(l.commands, ['pnpm test -- auth'])
  assert.deepEqual(l.directives, ['Fix the login bug, do not touch the DB schema', 'Also add a regression test'])
  assert.equal(l.humanMessages, 2)
  const text = renderLedger(l)
  assert.match(text, /tests\/auth\.spec\.ts/)
  assert.match(text, /"Also add a regression test"/)
})

test('ledger: ignores tool results and prior checkpoints as directives, truncates long ones', () => {
  assert.equal(isHumanMessage(result()), false)
  assert.equal(isHumanMessage(user('<compacted-summary>...')), false)
  const l = buildLedger([user('x'.repeat(1000))], { directiveChars: 50 })
  assert.equal(l.directives[0].length, 51)
})

test('instruction carries every section and the ledger; tight variant adds the hard limit', () => {
  const ins = buildInstruction(buildLedger(span))
  for (const [title] of CHECKPOINT_SECTIONS) assert.match(ins, new RegExp(`## ${title.replace(/[()]/g, '\\$&')}`))
  assert.match(ins, /src\/auth\.ts/)
  assert.doesNotMatch(ins, /HARD LIMIT/)
  assert.match(buildInstruction(buildLedger(span), { tight: true }), /HARD LIMIT/)
  assert.match(buildMergeInstruction(['A', 'B']), /### Part 2\nB/)
})

test('split happens at a user-message boundary near the middle, never inside a tool pair', () => {
  const [a, b] = splitAtHumanBoundary(span)
  assert.equal(a.length + b.length, span.length)
  assert.equal(b[0].content[0].text, 'Also add a regression test')
  assert.equal(splitAtHumanBoundary([call('read', {}), result()]), undefined)
})

test('target: configured summariser → last routed request → agent defaults', () => {
  const agent = { session: { requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-v4-pro' } }) }, options: { provider: 'x', model: 'y' } }
  assert.deepEqual(resolveTarget({ summarizationProvider: '', summarizationModel: '' }, agent), { provider: 'deepseek', model: 'deepseek-v4-pro' })
  assert.deepEqual(resolveTarget({ summarizationProvider: 'deepseek', summarizationModel: 'deepseek-flash' }, agent), { provider: 'deepseek', model: 'deepseek-flash' })
  assert.deepEqual(resolveTarget({ summarizationProvider: '' }, { session: { requestHeader: () => undefined }, options: { provider: 'x', model: 'y' } }), { provider: 'x', model: 'y' })
  assert.throws(() => resolveTarget({ summarizationProvider: '' }, { session: { requestHeader: () => undefined }, options: {} }), /no provider/)
})

// ── ledger v2: anchors that a summary must never lose ──────────────────────

const failedCall = (name, args) => ({ role: 'assistant', content: [{ type: 'tool-call', id: 'f1', name, arguments: JSON.stringify(args) }] })
const failedResult = (text) => ({ role: 'user', content: [{ type: 'tool-result', toolCallId: 'f1', isError: true, content: [{ type: 'text', text }] }] })

test('every user message is carried, not the last few', () => {
  const many = []
  for (let i = 1; i <= 40; i += 1) many.push(user(`инструкция номер ${i}`))
  const ledger = buildLedger(many)
  assert.equal(ledger.humanMessages, 40)
  assert.equal(ledger.directives.length, 40, 'спецификация работы не режется до десяти строк')
  assert.match(renderLedger(ledger), /инструкция номер 1"/)
})

test('a pathological span is trimmed from the OLD end, and says so', () => {
  const huge = []
  for (let i = 0; i < 40; i += 1) huge.push(user(`${i} ${'x'.repeat(1500)}`))
  const ledger = buildLedger(huge, { directiveBudget: 6000 })
  assert.ok(ledger.directives.length < 40)
  assert.ok(ledger.directives.at(-1).startsWith('39 '), 'последние указания остаются')
  assert.match(renderLedger(ledger), /omitted for length/)
})

test('one directive longer than the cap is truncated, not dropped', () => {
  const ledger = buildLedger([user('a'.repeat(5000))], { directiveChars: 100 })
  assert.equal(ledger.directives.length, 1)
  assert.equal(ledger.directives[0].length, 101)
})

test('the live plan is an anchor: the latest write wins', () => {
  const ledger = buildLedger([
    call('todo_write', { todos: [{ content: 'старый план', status: 'pending' }] }),
    result(),
    call('todo_write', { todos: [{ content: 'поднять шлюз', status: 'in_progress' }, { content: 'написать тест', status: 'pending' }] }),
    result(),
  ])
  assert.match(ledger.plan, /\[in_progress\] поднять шлюз/)
  assert.doesNotMatch(ledger.plan, /старый план/)
  assert.match(renderLedger(ledger), /live plan/)
})

test('a failed tool call is an anchor and keeps the tool that failed', () => {
  const ledger = buildLedger([
    failedCall('bash', { command: 'pnpm test' }),
    failedResult('FAIL src/auth.test.ts — expected 200, got 500'),
  ])
  assert.deepEqual(ledger.failures.map((f) => f.tool), ['bash'])
  assert.match(ledger.failures[0].message, /expected 200, got 500/)
  assert.match(renderLedger(ledger), /Most recent tool failures/)
})

test('a span with nothing to anchor renders no empty anchor sections', () => {
  const text = renderLedger(buildLedger([user('привет')]))
  assert.doesNotMatch(text, /live plan/)
  assert.doesNotMatch(text, /tool failures/)
})

test('the pointer names the session and both recall tools', () => {
  const text = recallPointer('session-abc')
  assert.match(text, /session-abc/)
  assert.match(text, /session_event_search/)
  assert.match(text, /session_event_read/)
  assert.match(text, /do not guess/)
})

test('our defaults compact later and deeper than upstream', () => {
  // Upstream: 0.80 / 0.16 / 8192. One deep compaction beats two shallow ones
  // when a cache hit costs a thirtieth of a miss.
  assert.ok(PRO_DEFAULTS.thresholdRatio > 0.8)
  assert.ok(PRO_DEFAULTS.retainRatio > 0.16)
  assert.ok(PRO_DEFAULTS.maxTokens >= 16_384)
  // The window the pair implies must still leave room to compact into.
  assert.ok(PRO_DEFAULTS.thresholdRatio - PRO_DEFAULTS.retainRatio > 0.5)
})

test('the instruction makes the ledger a floor, not a hint', () => {
  const text = buildInstruction(buildLedger(span))
  assert.match(text, /user instruction, plan item and failure/)
  assert.match(text, /it is the floor/)
})
