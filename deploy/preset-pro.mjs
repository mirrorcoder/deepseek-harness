#!/usr/bin/env node
// Turn the shipped `standard` agent preset into our `pro` preset.
//
// Three edits, each anchored on something the upstream file really says. A
// missing anchor is a refusal, not a guess: the preset is the composition every
// session joins, and a silently half-applied edit would be a harness that looks
// configured and is not.
//
//   1. compaction engine → dsh-ext-compaction-pro
//   2. tool-result pruning → tighter, because pruned detail is now RECOVERABLE
//   3. + tool-session-query → the recall tools that make (2) safe
//
// Usage: node preset-pro.mjs <agent.cordis.yml>   (edits in place)
import { readFileSync, writeFileSync } from 'node:fs'

/** The pruner's budget once history can be paged back in. */
export const PRUNE = { thresholdChars: 4096, headChars: 2048, tailChars: 512 }

const RECALL_ROW = `
# ── recall (added by deploy/preset-pro.mjs) ─────────────────────────────────
#
# The five session-query tools over the full-text index the host plane owns.
# They are what turns compaction from loss into paging: a checkpoint condenses
# a span, and these read the span back event by event when a detail is missing.
# Tighter tool-result pruning above is only defensible because of this row.
- id: tool-session-query
  name: '@deepseek-ai/dsh-tool-session-query'
  config:
    maxSearchResults: 40
`

/**
 * Apply every edit to the preset text.
 *
 * `recall` is a fact about THIS machine, not a preference: a preset row naming
 * a plugin the profile cannot resolve does not degrade, it refuses to mount,
 * and then no session starts at all. The installer therefore only asks for the
 * row once the package is really in the profile, and the compaction checkpoint
 * separately checks the registry before promising the tools exist.
 * @param {string} text - the shipped standard preset.
 * @param {{recall?: boolean}} [options] - whether the recall row may be added.
 * @returns {string} the pro preset.
 * @throws when an anchor is missing or ambiguous.
 */
export function patchPreset(text, options = {}) {
  let out = text

  const engine = /name: '@deepseek-ai\/dsh-compaction-basic'/g
  const engineHits = out.match(engine) ?? []
  if (engineHits.length !== 1) {
    throw new Error(`expected exactly one compaction-basic row, found ${engineHits.length} — upstream changed, refusing to guess`)
  }
  out = out.replace(engine, 'name: dsh-ext-compaction-pro')

  const prunerAt = out.indexOf("name: '@deepseek-ai/dsh-compaction-tool-result-pruner'")
  if (prunerAt === -1) throw new Error('tool-result pruner row not found — upstream changed, refusing to guess')
  const tail = out.slice(prunerAt)
  let patchedTail = tail
  for (const [key, value] of Object.entries(PRUNE)) {
    const line = new RegExp(`(\\n\\s+${key}: )\\d+`)
    if (!line.test(patchedTail)) throw new Error(`pruner row has no ${key} to retune — upstream changed, refusing to guess`)
    patchedTail = patchedTail.replace(line, `$1${value}`)
  }
  out = out.slice(0, prunerAt) + patchedTail

  if (options.recall === true) {
    if (out.includes('dsh-tool-session-query')) {
      throw new Error('the preset already carries a session-query row — refusing to add a second')
    }
    out = `${out.replace(/\s*$/, '')}\n${RECALL_ROW}`
  }
  return out
}

if (process.argv[2] !== undefined) {
  const path = process.argv[2]
  const recall = process.env.DSH_PRESET_RECALL === '1'
  writeFileSync(path, patchPreset(readFileSync(path, 'utf8'), { recall }))
  process.stdout.write(`   ✓ preset patched: ${path}${recall ? ' (+ recall)' : ' (no recall row: the package is not in the profile)'}\n`)
}
