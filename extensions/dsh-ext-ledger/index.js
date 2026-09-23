// dsh-ext-ledger — what the harness spent today, where, and against what budget.
//
//   • every model request's usage is appended to $DSH_HOME/ledger, tagged with
//     the project it ran in;
//   • the provider balance is read every few minutes, so the day's spend is the
//     sum of real decreases (see core.js), not an estimate from a price table;
//   • crossing the daily budget, or a low balance, sends one warning to
//     Telegram — once per day per threshold, not once per request;
//   • at the configured hour the day's report goes to Telegram: spend, per
//     project tokens and cache ratio, and the sessions that were worked on;
//   • `/cost` shows the same report on demand.
//
// Delivery goes through the `telegram/notify` event, so this extension knows
// nothing about bots and works (silently) in a deployment without one.
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { budgetState, budgetText, dayKey, localHour, renderDaily, spentFrom, totalsByProject } from './core.js'

export const name = 'ext-ledger'

export const Config = z.object({
  enabled: z.boolean().default(true),
  /** IANA zone the day and the report hour are counted in; empty = the container's TZ. */
  timeZone: z.string().default(''),
  /** Local hour the daily report is sent. */
  reportHour: z.number().default(21),
  /** Daily spend that triggers the warning, in the account currency; 0 turns it off. */
  dailyBudget: z.number().default(3),
  /** Fraction of the budget at which the first warning goes out. */
  warnRatio: z.number().default(0.8),
  /** Balance below which one "top up soon" warning is sent per day; 0 turns it off. */
  lowBalance: z.number().default(2),
  /** How often the provider balance is read. */
  balanceEveryMinutes: z.number().default(15),
  /** Credential reference of the provider key. */
  keyRef: z.string().role('credential-ref').default('DEEPSEEK_API_KEY'),
  balanceUrl: z.string().default('https://api.deepseek.com/user/balance'),
})

export function apply(ctx, initial) {
  let config = initial
  if (config.enabled === false) return
  // Budget, hour and thresholds are editable in Settings → ledger and apply live.
  let read = () => initial
  ctx.inject(['settings'], (sctx) => {
    sctx.settings.installSection(ctx, 'ledger', Config, initial, {
      setSource: (source) => { read = source },
      onChange: () => {
        const next = {}
        for (const [key, value] of Object.entries(read() ?? {})) if (value !== undefined) next[key] = value
        config = { ...initial, ...next }
      },
    })
  })
  const zone = config.timeZone || process.env.TZ || 'UTC'
  const dir = join(process.env.DSH_HOME ?? '/data/dsh', 'ledger')
  const stateFile = join(dir, 'state.json')
  const now = () => new Date()
  const today = () => dayKey(now(), zone)

  const notify = (text) => {
    try {
      ctx.emit('telegram/notify', { text, html: true, topic: 'reports' })
    } catch {
      // No Telegram in this composition: the ledger still records.
    }
  }

  // ── small durable state: what was already said today ─────────────────────
  let state = { reported: '', warned: {}, lowWarned: '' }
  const loadState = async () => {
    try {
      state = { ...state, ...JSON.parse(await readFile(stateFile, 'utf8')) }
    } catch {
      // first run
    }
  }
  const saveState = async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(stateFile, JSON.stringify(state))
  }

  const readLines = async (file) => {
    try {
      return (await readFile(join(dir, file), 'utf8'))
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return undefined
          }
        })
        .filter((row) => row !== undefined)
    } catch {
      return []
    }
  }
  const append = async (file, row) => {
    await mkdir(dir, { recursive: true })
    await appendFile(join(dir, file), `${JSON.stringify(row)}\n`)
  }

  // ── which project a session belongs to ───────────────────────────────────
  const projectOf = (sessionId) => {
    const session = sessionId === undefined ? undefined : ctx.get('sessions')?.get?.(sessionId)
    const cwd = session?.header?.cwd ?? session?.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) return undefined
    const registry = ctx.get('workspaceRegistry')
    let best
    try {
      for (const workspace of registry?.list?.() ?? []) {
        const path = workspace.path
        if (cwd === path || cwd.startsWith(`${path}/`)) {
          if (best === undefined || path.length > best.path.length) best = workspace
        }
      }
    } catch {
      // registry unavailable: fall back to the directory name
    }
    return best?.name ?? cwd.split('/').filter(Boolean).pop()
  }

  // ── usage: every request, exact ──────────────────────────────────────────
  ctx.on('llm/stream', (options, next) => (async function* () {
    for await (const chunk of next()) {
      if (chunk?.type === 'usage') {
        const usage = chunk.usage ?? {}
        void append(`usage-${today()}.jsonl`, {
          at: Date.now(),
          sessionId: options.sessionId,
          project: projectOf(options.sessionId),
          model: options.model,
          purpose: options.purpose,
          input: (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
          cacheRead: usage.cacheReadTokens ?? 0,
          output: usage.outputTokens ?? 0,
        }).catch(() => {})
      }
      yield chunk
    }
  })())

  // ── balance: real money ──────────────────────────────────────────────────
  const readBalance = async () => {
    const credentials = ctx.get('credentials')
    const resolved = credentials === undefined ? undefined : await credentials.resolve(credentialRef(config.keyRef))
    const key = resolved?.value ?? process.env[config.keyRef]
    if (key === undefined || key.length === 0) return undefined
    const response = await fetch(config.balanceUrl, { headers: { authorization: `Bearer ${key}` } })
    if (!response.ok) return undefined
    const body = await response.json()
    const info = (body?.balance_infos ?? [])[0]
    const total = Number(info?.total_balance)
    return Number.isFinite(total) ? { total, currency: info?.currency ?? '' } : undefined
  }

  /**
   * Today's spend, starting from YESTERDAY's last reading. Without it the money
   * spent between midnight and the first reading of the day — or since the
   * last reading before a restart — would belong to no day at all.
   */
  const spentToday = async () => {
    const snapshots = await readLines(`balance-${today()}.jsonl`)
    if (snapshots.length === 0) return undefined
    const yesterday = await readLines(`balance-${dayKey(new Date(Date.now() - 86_400_000), zone)}.jsonl`)
    const series = yesterday.length > 0 ? [yesterday.at(-1), ...snapshots] : snapshots
    return { spent: spentFrom(series), balance: snapshots.at(-1).total }
  }

  const checkBalance = async () => {
    const reading = await readBalance().catch(() => undefined)
    if (reading === undefined) return
    const day = today()
    await append(`balance-${day}.jsonl`, { at: Date.now(), total: reading.total })
    const money = await spentToday()
    if (money === undefined) return

    const level = budgetState(money.spent, config.dailyBudget, config.warnRatio)
    if ((level === 'warn' || level === 'over') && state.warned[day] !== level && !(state.warned[day] === 'over')) {
      state.warned = { [day]: level }
      await saveState()
      notify(budgetText(level, money.spent, config.dailyBudget))
    }
    if (config.lowBalance > 0 && reading.total < config.lowBalance && state.lowWarned !== day) {
      state.lowWarned = day
      await saveState()
      notify(`💳 На счету DeepSeek осталось <b>$${reading.total.toFixed(2)}</b> — пора пополнить.`)
    }
  }

  // ── the report ───────────────────────────────────────────────────────────
  const buildReport = async (day = today()) => {
    const lines = await readLines(`usage-${day}.jsonl`)
    const money = day === today() ? await spentToday() : undefined
    const sessions = []
    const controller = ctx.get('sessionController')
    if (controller !== undefined) {
      try {
        const items = (await controller.list({}, new AbortController().signal)).items
        for (const item of items) {
          if (item.blank || typeof item.updatedAt !== 'number') continue
          if (dayKey(new Date(item.updatedAt), zone) !== day) continue
          const title = item.title ?? ''
          if (title.length === 0 || title.startsWith('⚙️')) continue
          const cwd = item.cwd ?? ''
          sessions.push({ project: cwd.split('/').filter(Boolean).pop() ?? '—', title })
        }
      } catch {
        // the list is decoration; the numbers stand without it
      }
    }
    return renderDaily({
      day,
      ...(money === undefined ? {} : { spent: money.spent, balance: money.balance }),
      budget: config.dailyBudget,
      projects: totalsByProject(lines),
      sessions,
    })
  }

  const tick = async () => {
    const day = today()
    if (localHour(now(), zone) !== config.reportHour || state.reported === day) return
    state.reported = day
    await saveState()
    notify(await buildReport(day))
  }

  // ── timers ───────────────────────────────────────────────────────────────
  ctx.effect(() => {
    let stopped = false
    void loadState().then(() => {
      if (stopped) return
      // First reading shortly after boot, so a restart does not leave the day blind.
      setTimeout(() => void checkBalance().catch(() => {}), 30_000)
    })
    const balanceTimer = setInterval(() => void checkBalance().catch(() => {}), Math.max(1, config.balanceEveryMinutes) * 60_000)
    const reportTimer = setInterval(() => void tick().catch(() => {}), 60_000)
    return () => {
      stopped = true
      clearInterval(balanceTimer)
      clearInterval(reportTimer)
    }
  }, 'ext-ledger: timers')

  // ── /cost ────────────────────────────────────────────────────────────────
  ctx.inject(['commands'], (cctx) => {
    cctx.effect(() => cctx.commands.register({
      name: 'cost',
      description: 'Spend today: money from the provider balance, tokens per project, sessions worked on',
      recordInput: false,
      handler: async () => ({
        kind: 'success',
        text: (await buildReport()).replace(/<[^>]+>/g, ''),
      }),
    }))
  })
}
