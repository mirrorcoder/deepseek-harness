// dsh-ext-peak-guard — usage-rate budget aware of DeepSeek peak pricing hours.
//
// * Listens on the `llm/stream` waterfall (every model call in the process).
// * Sums billed tokens (uncached input + cache read + cache write + output)
//   from provider `usage` chunks into a rolling window.
// * Two budgets: peak and off-peak tokens per window. At `warnRatio` the model
//   gets a system-prompt note to economise; over budget the call is declined
//   with error code PEAK_GUARD (the turn stops and the user sees why) until the
//   window drains. `action: warn` disables the decline.
// * `/peak` command prints the live status. Settings live-reload from
//   $DSH_HOME/settings.yaml under `peak-guard:`.
import z from '@deepseek-ai/schemastery'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { DEFAULT_HOLIDAYS, DEFAULT_PEAK_WINDOWS, RollingMeter, isPeak, nextBoundary } from './schedule.js'

export const name = 'ext-peak-guard'
export const inject = ['llm']

const Window = z.object({
  days: z.array(z.number()).default([1, 2, 3, 4, 5]),
  from: z.string().required(),
  to: z.string().required(),
})

export const Config = z.object({
  /** Master switch. */
  enabled: z.boolean().default(true),
  /** Cost-weighted tokens allowed per rolling window during peak hours (0 = unlimited). */
  peakTokensPerMinute: z.number().default(120_000),
  /** Cost-weighted tokens allowed per rolling window off-peak (0 = unlimited). */
  offPeakTokensPerMinute: z.number().default(400_000),
  /**
   * Price weights relative to one uncached input token (DeepSeek: cache hit
   * ≈ 1/30 of a miss, output ≈ 3× input). Budgets count weighted tokens, so a
   * big warm prefix that hits the cache barely moves the meter while fresh
   * input and output do.
   */
  weights: z.object({
    input: z.number().default(1),
    cacheRead: z.number().default(0.04),
    cacheWrite: z.number().default(1),
    output: z.number().default(3),
  }).default({ input: 1, cacheRead: 0.04, cacheWrite: 1, output: 3 }),
  /** Rolling window length in seconds. */
  windowSeconds: z.number().default(60),
  /** Fraction of the budget at which the model is asked to economise. */
  warnRatio: z.number().default(0.7),
  /** `block` declines calls over budget; `warn` only warns. */
  action: z.union(['block', 'warn']).default('block'),
  /** Only guard these providers (empty = all). DeepSeek pricing applies to `deepseek`. */
  providers: z.array(z.string()).default(['deepseek', 'deepseek-official']),
  /** Peak windows (UTC). */
  peakWindows: z.array(Window).default(DEFAULT_PEAK_WINDOWS),
  /** Chinese public holidays (YYYY-MM-DD) that are off-peak even on weekdays. */
  holidays: z.array(z.string()).default(DEFAULT_HOLIDAYS),
})

const SETTINGS_NS = 'peak-guard'

export function billed(usage) {
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

/** Cost-weighted token count: what actually moves the bill. */
export function weighted(usage, w = { input: 1, cacheRead: 0.04, cacheWrite: 1, output: 3 }) {
  return Math.round(
    (usage.inputTokens ?? 0) * w.input
    + (usage.cacheReadTokens ?? 0) * w.cacheRead
    + (usage.cacheWriteTokens ?? 0) * w.cacheWrite
    + (usage.outputTokens ?? 0) * w.output,
  )
}

function fmt(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/**
 * The system-prompt text. A pure function of the configuration and one
 * boolean, so it takes exactly two values per deployment and the provider's
 * prefix cache survives every request in between.
 */
export function stablePolicyText(config, peak) {
  const budget = peak ? config.peakTokensPerMinute : config.offPeakTokensPerMinute
  return [
    `Usage budget: DeepSeek pricing is currently ${peak ? 'PEAK (2x)' : 'off-peak (half price)'}.`,
    budget > 0
      ? `This deployment allows about ${fmt(budget)} cost-weighted tokens per ${config.windowSeconds}s; over that a request is declined until the window drains.`
      : 'No rate budget is set.',
    'Cached input costs a fraction of fresh input, so keep the early part of the conversation stable: do not re-read files you already read, batch tool calls, ask for narrow file ranges, and keep answers tight.',
  ].join(' ')
}

/** The pure core, shared with tests: decide + record on a meter. */
export function createGuard(getConfig, meter) {
  const state = { declinedCalls: 0, overBudgetSeen: 0, totalBilled: 0, totalWeighted: 0 }
  const status = (now = new Date()) => {
    const config = getConfig()
    const peak = isPeak(now, config.peakWindows, config.holidays)
    const budget = peak ? config.peakTokensPerMinute : config.offPeakTokensPerMinute
    meter.windowMs = config.windowSeconds * 1000
    const used = meter.total(now.getTime())
    const ratio = budget > 0 ? used / budget : 0
    const boundary = nextBoundary(now, config.peakWindows, config.holidays)
    return { peak, budget, used, ratio, boundary, warn: budget > 0 && ratio >= config.warnRatio, over: budget > 0 && used >= budget }
  }
  /** @returns {undefined | Error} an error means: decline this call */
  const check = (provider, now = new Date()) => {
    const config = getConfig()
    if (!config.enabled) return undefined
    if (config.providers.length > 0 && !config.providers.includes(provider)) return undefined
    const s = status(now)
    if (!s.over) return undefined
    state.overBudgetSeen++
    if (config.action !== 'block') return undefined
    state.declinedCalls++
    const key = s.peak ? 'peakTokensPerMinute' : 'offPeakTokensPerMinute'
    return new LlmError(
      `Peak-guard: usage budget exhausted (${fmt(s.used)} of ${fmt(s.budget)} tokens in the last ${config.windowSeconds}s during ${s.peak ? 'DeepSeek PEAK hours (2x price)' : 'off-peak'}). Wait ~${meter.secondsUntilRelief(now.getTime())}s and resend, or raise peak-guard.${key} in settings.yaml.`,
      'PEAK_GUARD',
    )
  }
  const record = (usage) => {
    const config = getConfig()
    const t = weighted(usage, config.weights)
    meter.add(t)
    state.totalBilled += billed(usage)
    state.totalWeighted += t
    return t
  }
  return { status, check, record, state }
}

export function apply(ctx, initial) {
  let config = initial
  const guard = createGuard(() => config, new RollingMeter((initial.windowSeconds ?? 60) * 1000))

  // 1. Settings section (live-editable in settings.yaml, listed in Settings → Plugins).
  ctx.inject(['settings'], (sctx) => {
    sctx.settings.installSection(ctx, SETTINGS_NS, Config, initial, {
      setSource: (current) => { config = current() },
      onChange: () => { config = { ...config } },
    })
  })

  // 2. System-prompt section so the model economises by default.
  //
  // CACHE HYGIENE: the system prompt is the head of every request, so any text
  // that differs between two requests invalidates the provider's prefix cache
  // for the WHOLE conversation behind it — on DeepSeek that turns cache-hit
  // input (about a thirtieth of the price) into fresh input. This section
  // therefore carries only facts that change at most a couple of times a day:
  // the pricing mode and the standing budget. Live counters belong to `/peak`
  // and `/context`, which the operator reads on demand, and enforcement does
  // not need the model's cooperation anyway — an over-budget call is declined
  // with an explicit reason the model then sees.
  ctx.inject(['systemPrompt'], (pctx) => {
    pctx.effect(() => pctx.systemPrompt.section({
      name: 'ext:peak-guard',
      order: 950,
      text: () => (config.enabled ? stablePolicyText(config, guard.status().peak) : ''),
    }))
  })

  // 3. The guard itself.
  ctx.on('llm/stream', (options, next) => {
    const refusal = guard.check(options.provider)
    if (refusal !== undefined) throw refusal
    if (!config.enabled) return next()
    return (async function* () {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') guard.record(chunk.usage)
        yield chunk
      }
    })()
  })

  // 4. `/peak` status command.
  ctx.inject(['commands'], (cctx) => {
    cctx.effect(() => cctx.commands.register({
      name: 'peak',
      description: 'Usage budget status: peak/off-peak, rolling usage vs budget',
      recordInput: false,
      handler: () => {
        const s = guard.status()
        const text = [
          `Pricing mode: ${s.peak ? 'PEAK (2x)' : 'off-peak (0.5x)'}${s.boundary ? `, switches at ${s.boundary.toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''}`,
          `Rolling ${config.windowSeconds}s usage: ${fmt(s.used)} / ${s.budget > 0 ? fmt(s.budget) : '∞'} (${Math.round(s.ratio * 100)}%)`,
          `Process totals: ${fmt(guard.state.totalBilled)} raw tokens = ${fmt(guard.state.totalWeighted)} cost-weighted (cache hits ×${config.weights.cacheRead}, output ×${config.weights.output}); declined calls: ${guard.state.declinedCalls}; action: ${config.action}${config.enabled ? '' : ' (DISABLED)'}`,
          `Peak windows (UTC): ${config.peakWindows.map((w) => `${w.from}-${w.to} days[${w.days.join(',')}]`).join('; ')}`,
        ].join('\n')
        return { kind: 'success', text }
      },
    }))
  })
}
