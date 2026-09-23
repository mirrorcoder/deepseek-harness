// Run inside the dsh container (deps resolve from the profile closure):
//   node --test /data/dsh/profiles/web/node_modules/dsh-ext-peak-guard/test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPeak, nextBoundary, RollingMeter, DEFAULT_PEAK_WINDOWS } from './schedule.js'
import { createGuard, billed, weighted, stablePolicyText } from './index.js'

const W = { input: 1, cacheRead: 0.04, cacheWrite: 1, output: 3 }
const cfg = (over = {}) => ({
  enabled: true, peakTokensPerMinute: 1000, offPeakTokensPerMinute: 5000, windowSeconds: 60,
  warnRatio: 0.7, action: 'block', providers: ['deepseek'], peakWindows: DEFAULT_PEAK_WINDOWS, holidays: ['2026-10-01'],
  weights: { input: 1, cacheRead: 0, cacheWrite: 1, output: 1 }, ...over,
})

test('peak calendar: weekday windows, weekends, holidays', () => {
  assert.equal(isPeak(new Date('2026-09-21T02:30:00Z')), true)   // Monday 02:30 UTC
  assert.equal(isPeak(new Date('2026-09-21T05:00:00Z')), false)  // gap between windows
  assert.equal(isPeak(new Date('2026-09-21T09:59:00Z')), true)
  assert.equal(isPeak(new Date('2026-09-21T10:00:00Z')), false)  // end exclusive
  assert.equal(isPeak(new Date('2026-09-20T02:30:00Z')), false)  // Sunday
  assert.equal(isPeak(new Date('2026-10-01T02:30:00Z'), DEFAULT_PEAK_WINDOWS, ['2026-10-01']), false) // holiday
  assert.equal(nextBoundary(new Date('2026-09-21T02:30:00Z')).toISOString(), '2026-09-21T04:00:00.000Z')
})

test('rolling meter drops old entries and reports relief time', () => {
  const m = new RollingMeter(60_000)
  m.add(100, 0); m.add(200, 30_000)
  assert.equal(m.total(59_000), 300)
  assert.equal(m.total(61_000), 200)
  assert.equal(m.secondsUntilRelief(61_000), 29)   // oldest entry at 30s leaves at 90s
})

test('billed = raw sum; weighted = price-relative (cache hits nearly free, output 3x)', () => {
  const u = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 1 }
  assert.equal(billed(u), 116)
  assert.equal(weighted(u, W), 10 + 4 + 1 + 15)
  // a 100k warm-prefix request costs about as much as 4k fresh input tokens
  assert.equal(weighted({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 100_000 }, W), 4000)
})

test('guard: declines over budget during peak, warns first, ignores other providers', () => {
  const meter = new RollingMeter(60_000)
  const g = createGuard(() => cfg(), meter)
  const peakNow = new Date('2026-09-21T02:30:00Z')
  assert.equal(g.check('deepseek', peakNow), undefined)
  g.record({ inputTokens: 600, outputTokens: 100 })
  assert.equal(g.status(peakNow).warn, true)
  assert.equal(g.check('deepseek', peakNow), undefined)          // 700 < 1000
  g.record({ inputTokens: 300, outputTokens: 0 })
  const err = g.check('deepseek', peakNow)
  assert.ok(err instanceof Error)
  assert.equal(err.code, 'PEAK_GUARD')
  assert.match(err.message, /PEAK hours/)
  assert.equal(g.check('anthropic', peakNow), undefined)         // provider filter
  assert.equal(g.state.declinedCalls, 1)
})

test('cache hygiene: the system-prompt text does not move with usage', () => {
  // The prompt is the head of every request; text that differs between two
  // requests invalidates the provider prefix cache for the whole conversation.
  const c = cfg()
  const before = stablePolicyText(c, true)
  const meter = new RollingMeter(60_000)
  const g = createGuard(() => c, meter)
  g.record({ inputTokens: 900, outputTokens: 100 })
  g.record({ inputTokens: 50, outputTokens: 10 })
  assert.equal(stablePolicyText(c, true), before, 'usage must not appear in the prompt')
  // only the pricing mode moves it, and that happens twice a day
  assert.notEqual(stablePolicyText(c, false), before)
  assert.match(before, /PEAK \(2x\)/)
  assert.match(stablePolicyText(c, false), /off-peak/)
  assert.match(before, /do not re-read files you already read/)
  assert.equal(stablePolicyText({ ...c, peakTokensPerMinute: 0 }, true).includes('No rate budget'), true)
})

test('guard: off-peak budget is separate; action=warn never declines; disabled is transparent', () => {
  const meter = new RollingMeter(60_000)
  const g = createGuard(() => cfg(), meter)
  const offPeak = new Date('2026-09-21T05:00:00Z')
  g.record({ inputTokens: 1000, outputTokens: 0 })
  assert.equal(g.check('deepseek', offPeak), undefined)          // 1000 < 5000 off-peak
  const warnOnly = createGuard(() => cfg({ action: 'warn', peakTokensPerMinute: 10 }), new RollingMeter(60_000))
  warnOnly.record({ inputTokens: 50, outputTokens: 0 })
  assert.equal(warnOnly.check('deepseek', new Date('2026-09-21T02:30:00Z')), undefined)
  assert.equal(warnOnly.state.overBudgetSeen, 1)
  const off = createGuard(() => cfg({ enabled: false, peakTokensPerMinute: 1 }), new RollingMeter(60_000))
  off.record({ inputTokens: 50, outputTokens: 0 })
  assert.equal(off.check('deepseek', new Date('2026-09-21T02:30:00Z')), undefined)
})

// ── offpeak_slot: when "ночью" should fire ────────────────────────────────
import { offPeakSlot as slotOf, localText as localOf } from './schedule.js'

test('during peak, the cheap stretch starts when the window closes and runs until the next one', () => {
  const at = new Date('2026-09-22T07:00:00Z') // вторник, внутри пика 06–10 UTC
  const slot = slotOf(at, { timeZone: 'Europe/Moscow' })
  assert.equal(slot.nowIsPeak, true)
  assert.equal(slot.soonest.toISOString(), '2026-09-22T10:00:00.000Z')
  assert.equal(slot.soonestEnds.toISOString(), '2026-09-23T01:00:00.000Z')
})

test('off-peak, the soonest cheap moment is now', () => {
  const at = new Date('2026-09-22T12:00:00Z')
  const slot = slotOf(at, { timeZone: 'Europe/Moscow' })
  assert.equal(slot.nowIsPeak, false)
  assert.equal(slot.soonest.getTime(), at.getTime())
})

test('"tonight" is the next 23:00 on the LOCAL clock', () => {
  const at = new Date('2026-09-22T12:00:00Z') // 15:00 по Москве
  const slot = slotOf(at, { timeZone: 'Europe/Moscow' })
  assert.equal(slot.tonight.toISOString(), '2026-09-22T20:00:00.000Z') // 23:00 MSK
  assert.equal(localOf(slot.tonight, 'Europe/Moscow'), '2026-09-22 23:00 (Europe/Moscow)')
})

test('a Chinese public holiday is off-peak even on a weekday morning', () => {
  const slot = slotOf(new Date('2026-09-25T07:00:00Z'), { timeZone: 'UTC' })
  assert.equal(slot.nowIsPeak, false)
})
