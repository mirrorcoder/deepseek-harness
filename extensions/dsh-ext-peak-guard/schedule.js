// DeepSeek pricing calendar (api-docs.deepseek.com/quick_start/pricing, read 2026-09-21):
// peak = 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday, excluding Chinese public
// holidays; off-peak rates are half of peak. Pure functions, no dsh imports.

/** @typedef {{days: number[], from: string, to: string}} Window  days: 0=Sun..6=Sat, times "HH:MM" UTC */

export const DEFAULT_PEAK_WINDOWS = [
  { days: [1, 2, 3, 4, 5], from: '01:00', to: '04:00' },
  { days: [1, 2, 3, 4, 5], from: '06:00', to: '10:00' },
]

// Mainland-China public holidays that fall on weekdays. Keep this list current
// in settings.yaml (`peak-guard.holidays`); verify each year's State Council
// notice (Spring Festival / Qingming / Dragon Boat / Mid-Autumn move annually).
export const DEFAULT_HOLIDAYS = [
  '2026-01-01', '2026-01-02',
  '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-23',
  '2026-04-06',
  '2026-05-01', '2026-05-04', '2026-05-05',
  '2026-06-19',
  '2026-09-25',
  '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07',
]

function minutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/** @returns {boolean} whether `at` (Date) is inside a peak window */
export function isPeak(at, windows = DEFAULT_PEAK_WINDOWS, holidays = DEFAULT_HOLIDAYS) {
  const day = at.getUTCDay()
  const iso = at.toISOString().slice(0, 10)
  if (holidays.includes(iso)) return false
  const now = at.getUTCHours() * 60 + at.getUTCMinutes()
  return windows.some((w) => w.days.includes(day) && now >= minutes(w.from) && now < minutes(w.to))
}

/** Next boundary (start or end of a peak window) after `at`, for status text. */
export function nextBoundary(at, windows = DEFAULT_PEAK_WINDOWS, holidays = DEFAULT_HOLIDAYS) {
  const state = isPeak(at, windows, holidays)
  const probe = new Date(at)
  probe.setUTCSeconds(0, 0)
  for (let i = 0; i < 60 * 24 * 8; i++) {
    probe.setUTCMinutes(probe.getUTCMinutes() + 1)
    if (isPeak(probe, windows, holidays) !== state) return probe
  }
  return undefined
}

/** Rolling-window token counter. */
export class RollingMeter {
  constructor(windowMs) {
    this.windowMs = windowMs
    this.events = []
  }

  add(tokens, now = Date.now()) {
    this.events.push([now, tokens])
    this.prune(now)
  }

  prune(now = Date.now()) {
    const cut = now - this.windowMs
    while (this.events.length && this.events[0][0] < cut) this.events.shift()
  }

  total(now = Date.now()) {
    this.prune(now)
    let s = 0
    for (const [, t] of this.events) s += t
    return s
  }

  /** Seconds until the oldest entry leaves the window (0 when empty). */
  secondsUntilRelief(now = Date.now()) {
    this.prune(now)
    if (this.events.length === 0) return 0
    return Math.max(1, Math.ceil((this.events[0][0] + this.windowMs - now) / 1000))
  }
}

/** "2026-09-23 23:00 (Europe/Moscow)" — for a human reading the answer. */
export function localText(at, timeZone) {
  const text = new Intl.DateTimeFormat('sv-SE', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(at)
  return `${text} (${timeZone})`
}

function localHourOf(at, timeZone) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).format(at)) % 24
}

/**
 * When the next cheap stretch starts, how long it lasts, and when "tonight" is.
 *
 * `soonest` is now when now is already off-peak — most of the day is — so a
 * request to "do it when it is cheaper" that arrives off-peak should simply run.
 * `tonight` is the next `nightHour` on the local clock, moved past a peak window
 * if one happens to cover it, for when the operator literally said "at night".
 */
export function offPeakSlot(at, options = {}) {
  const windows = options.windows ?? DEFAULT_PEAK_WINDOWS
  const holidays = options.holidays ?? DEFAULT_HOLIDAYS
  const zone = options.timeZone ?? 'UTC'
  const nightHour = options.nightHour ?? 23
  const nowIsPeak = isPeak(at, windows, holidays)
  const soonest = nowIsPeak ? nextBoundary(at, windows, holidays) : new Date(at)
  const soonestEnds = soonest === undefined ? undefined : nextBoundary(soonest, windows, holidays)

  let tonight
  const probe = new Date(at)
  probe.setUTCSeconds(0, 0)
  probe.setUTCMinutes(Math.ceil(probe.getUTCMinutes() / 15) * 15)
  for (let i = 0; i < 4 * 48; i++) {
    if (probe > at && localHourOf(probe, zone) === nightHour && probe.getUTCMinutes() === 0) {
      tonight = new Date(probe)
      break
    }
    probe.setUTCMinutes(probe.getUTCMinutes() + 15)
  }
  if (tonight !== undefined && isPeak(tonight, windows, holidays)) tonight = nextBoundary(tonight, windows, holidays)
  return { nowIsPeak, soonest, soonestEnds, tonight }
}
