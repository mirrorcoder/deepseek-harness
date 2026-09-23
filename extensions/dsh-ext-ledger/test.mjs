// The ledger's arithmetic and wording. Run inside the dsh container:
//   node --test /data/dsh/profiles/web/node_modules/dsh-ext-ledger/test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { budgetState, budgetText, dayKey, localHour, renderDaily, shortTokens, spentFrom, totalsByProject } from './core.js'

test('spend is the sum of decreases, and a top-up is not negative spend', () => {
  const snapshots = [
    { at: 1, total: 20.00 },
    { at: 2, total: 19.50 },
    { at: 3, total: 29.50 }, // пополнили на $10
    { at: 4, total: 29.20 },
  ]
  assert.equal(spentFrom(snapshots), 0.8)
  assert.equal(spentFrom([{ at: 1, total: 5 }]), 0, 'одна точка — ещё ничего не потрачено')
  assert.equal(spentFrom([]), 0)
})

test('the day is counted in the configured zone, not in UTC', () => {
  // 22:30 UTC on the 23rd is already the 24th in Moscow
  const at = new Date('2026-09-23T22:30:00Z')
  assert.equal(dayKey(at, 'Europe/Moscow'), '2026-09-24')
  assert.equal(dayKey(at, 'UTC'), '2026-09-23')
  assert.equal(localHour(at, 'Europe/Moscow'), 1)
})

test('the budget warns early, then says over, and can be switched off', () => {
  assert.equal(budgetState(1, 3), 'ok')
  assert.equal(budgetState(2.5, 3), 'warn')
  assert.equal(budgetState(3, 3), 'over')
  assert.equal(budgetState(100, 0), 'off')
  assert.match(budgetText('over', 3.1, 3), /исчерпан.*\$3\.10 из \$3\.00/)
  assert.equal(budgetText('ok', 1, 3), '')
})

test('usage folds into projects, busiest first', () => {
  const rows = totalsByProject([
    { project: 'aisignals', input: 10_000, cacheRead: 8_000, output: 500 },
    { project: 'hashtrade', input: 90_000, cacheRead: 80_000, output: 2_000 },
    { project: 'aisignals', input: 5_000, cacheRead: 0, output: 100 },
    { input: 100, output: 1 },
  ])
  assert.equal(rows[0].project, 'hashtrade')
  assert.equal(rows.find((r) => r.project === 'aisignals').requests, 2)
  assert.equal(rows.find((r) => r.project === 'aisignals').input, 15_000)
  assert.ok(rows.some((r) => r.project === 'без проекта'))
})

test('the report says what was spent, where, and on what', () => {
  const text = renderDaily({
    day: '2026-09-23',
    spent: 0.4213,
    balance: 20.12,
    budget: 3,
    projects: totalsByProject([{ project: 'aisignals', input: 100_000, cacheRead: 88_000, output: 3_000 }]),
    sessions: [{ project: 'aisignals', title: 'Атрибуция <трафика>' }],
  })
  assert.match(text, /Итоги дня · 2026-09-23/)
  assert.match(text, /\$0\.42<\/b> из \$3\.00 · на счету \$20\.12/)
  assert.match(text, /aisignals: 1 запр\., 100k вход \(88% из кэша\), 3k выход/)
  assert.match(text, /Атрибуция &lt;трафика&gt;/, 'заголовки экранируются')
})

test('a day without a balance reading says so instead of printing zero', () => {
  const text = renderDaily({ day: '2026-09-23', projects: [] })
  assert.match(text, /баланс ещё не снят/)
  assert.match(text, /Запросов к модели сегодня не было/)
})

test('token counts read at a glance', () => {
  assert.equal(shortTokens(950), '950')
  assert.equal(shortTokens(12_345), '12k')
  assert.equal(shortTokens(1_234_567), '1.2M')
})
