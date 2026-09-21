// Rendering of the /context report. Pure: takes numbers, returns text.

export function fmt(n) {
  if (!Number.isFinite(n)) return '?'
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

/** A 20-cell bar; the compaction threshold is marked with a pipe. */
export function bar(ratio, threshold, width = 20) {
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)))
  const mark = Math.max(0, Math.min(width - 1, Math.round(threshold * width)))
  const cells = []
  for (let i = 0; i < width; i++) {
    if (i === mark) cells.push(i < filled ? '#' : '|')
    else cells.push(i < filled ? '#' : '.')
  }
  return cells.join('')
}

/**
 * @param {{used?: number, window?: number, threshold: number, provider?: string,
 *          model?: string, usage: {input: number, output: number, cacheRead: number,
 *          cacheWrite: number, requests: number}, dedup: {hits: number, savedChars: number, calls: number}}} s
 */
export function contextReport(s) {
  const lines = []
  if (s.window !== undefined && s.used !== undefined && s.window > 0) {
    const ratio = s.used / s.window
    const left = Math.max(0, s.window - s.used)
    const untilCompaction = Math.max(0, Math.round(s.window * s.threshold) - s.used)
    lines.push(`Context window  ${fmt(s.used)} / ${fmt(s.window)} used (${Math.round(ratio * 100)}%), ${fmt(left)} free`)
    lines.push(`                [${bar(ratio, s.threshold)}]  | = compaction at ${Math.round(s.threshold * 100)}%`)
    lines.push(untilCompaction > 0
      ? `                ${fmt(untilCompaction)} tokens before this session compacts`
      : `                compaction threshold reached — the next step condenses the transcript`)
  } else {
    lines.push('Context window  unknown until this session routes its first request to a model')
    if (s.used !== undefined) lines.push(`                current transcript pressure: ${fmt(s.used)} tokens`)
  }
  if (s.provider !== undefined) lines.push(`Route           ${s.provider}/${s.model}`)

  const billedInput = s.usage.input + s.usage.cacheRead + s.usage.cacheWrite
  const hitRate = billedInput > 0 ? s.usage.cacheRead / billedInput : 0
  lines.push('')
  lines.push(`Since start     ${s.usage.requests} model request(s)`)
  lines.push(`Input           ${fmt(s.usage.input)} fresh + ${fmt(s.usage.cacheRead)} from prefix cache = ${Math.round(hitRate * 100)}% cache hits`)
  lines.push(`Output          ${fmt(s.usage.output)} tokens`)
  if (billedInput > 0) {
    // DeepSeek prices a cache hit at about 1/30 of a miss and output at ~3x
    // input, so this is what the traffic would have cost with no cache.
    const weighted = s.usage.input + s.usage.cacheRead * 0.04 + s.usage.cacheWrite + s.usage.output * 3
    const uncached = billedInput + s.usage.output * 3
    lines.push(`Cache saving    ${fmt(uncached - weighted)} cost-weighted tokens not paid for`)
  }
  lines.push(`Result dedup    ${s.dedup.hits} of ${s.dedup.calls} tool results were byte-identical repeats, ~${fmt(s.dedup.savedChars / 4)} tokens not resent`)
  return lines.join('\n')
}
