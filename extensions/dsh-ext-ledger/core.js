// What the harness spent, where, and whether that is still inside the budget.
//
// Money is taken from the provider's own balance, not from a price table: the
// DeepSeek API reports the account balance, and the sum of its DECREASES over a
// day is exactly what was billed that day — whatever the model, the cache-hit
// ratio or the peak discount. Increases are top-ups and are ignored, so a
// payment in the middle of the day does not read as negative spend.
//
// Tokens come from the request stream and are exact. They answer the other
// question — where the money went — per project and per model.
//
// Pure: dates, sums and wording. No fs, no network, no dsh.

/** YYYY-MM-DD of `at` in `timeZone`. */
export function dayKey(at, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(at)
  const pick = (type) => parts.find((part) => part.type === type)?.value
  return `${pick('year')}-${pick('month')}-${pick('day')}`
}

/** Local hour (0–23) of `at` in `timeZone`. */
export function localHour(at, timeZone) {
  const hour = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).format(at)
  return Number(hour) % 24
}

/**
 * What was billed across a series of balance readings.
 * @param {{at: number, total: number}[]} snapshots - oldest first.
 * @returns {number} the sum of decreases; a top-up is not negative spend.
 */
export function spentFrom(snapshots) {
  let spent = 0
  for (let i = 1; i < snapshots.length; i += 1) {
    const drop = snapshots[i - 1].total - snapshots[i].total
    if (drop > 0) spent += drop
  }
  return round(spent)
}

function round(value, digits = 4) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** Where a day stands against its budget. */
export function budgetState(spent, budget, warnRatio = 0.8) {
  if (!(budget > 0)) return 'off'
  if (spent >= budget) return 'over'
  if (spent >= budget * warnRatio) return 'warn'
  return 'ok'
}

/**
 * Fold per-request usage lines into per-project totals.
 * @param {{project?: string, model?: string, input?: number, cacheRead?: number, output?: number}[]} lines
 */
export function totalsByProject(lines) {
  const byProject = new Map()
  for (const line of lines ?? []) {
    const key = line.project || 'без проекта'
    const row = byProject.get(key) ?? { project: key, requests: 0, input: 0, cacheRead: 0, output: 0 }
    row.requests += 1
    row.input += line.input ?? 0
    row.cacheRead += line.cacheRead ?? 0
    row.output += line.output ?? 0
    byProject.set(key, row)
  }
  return [...byProject.values()].sort((a, b) => (b.input + b.output) - (a.input + a.output))
}

/** 12 345 → "12k", 1 234 567 → "1.2M". Tokens are read at a glance, not audited. */
export function shortTokens(value) {
  const n = Number(value) || 0
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

function escape(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * The daily report, as Telegram HTML.
 * @param {{day: string, spent?: number, balance?: number, budget?: number,
 *          projects: object[], sessions?: {project: string, title: string}[]}} report
 */
export function renderDaily(report) {
  const lines = [`📊 <b>Итоги дня · ${escape(report.day)}</b>`]
  if (report.spent !== undefined) {
    const budgetPart = report.budget > 0 ? ` из $${report.budget.toFixed(2)}` : ''
    lines.push(`Потрачено: <b>$${report.spent.toFixed(2)}</b>${budgetPart}${report.balance !== undefined ? ` · на счету $${report.balance.toFixed(2)}` : ''}`)
  } else {
    lines.push('Потрачено: баланс ещё не снят — траты покажу со следующего отчёта.')
  }

  const projects = report.projects ?? []
  if (projects.length === 0) {
    lines.push('', 'Запросов к модели сегодня не было.')
  } else {
    lines.push('', '<b>По проектам</b>')
    for (const row of projects.slice(0, 8)) {
      const cached = row.input > 0 ? Math.round((row.cacheRead / row.input) * 100) : 0
      lines.push(`• ${escape(row.project)}: ${row.requests} запр., ${shortTokens(row.input)} вход (${cached}% из кэша), ${shortTokens(row.output)} выход`)
    }
    if (projects.length > 8) lines.push(`…и ещё ${projects.length - 8}`)
  }

  const sessions = report.sessions ?? []
  if (sessions.length > 0) {
    lines.push('', '<b>Над чем работали</b>')
    for (const item of sessions.slice(0, 10)) {
      lines.push(`• ${escape(item.project)} — ${escape(item.title)}`)
    }
  }
  return lines.join('\n')
}

/** The one-line warning a budget crossing sends. */
export function budgetText(state, spent, budget) {
  if (state === 'over') return `🛑 <b>Дневной бюджет исчерпан</b>: потрачено $${spent.toFixed(2)} из $${budget.toFixed(2)}.`
  if (state === 'warn') return `⚠️ <b>Дневной бюджет на исходе</b>: потрачено $${spent.toFixed(2)} из $${budget.toFixed(2)}.`
  return ''
}
