// Run inside the dsh container:
//   node --test /data/dsh/profiles/web/node_modules/dsh-ext-compaction-pro/test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLedger, renderLedger, splitAtHumanBoundary, isHumanMessage } from './ledger.js'
import { buildInstruction, buildMergeInstruction, resolveTarget, CHECKPOINT_SECTIONS } from './index.js'

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
