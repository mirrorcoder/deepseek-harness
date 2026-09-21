// dsh-ext-version — makes the running build identifiable.
//
// `deploy/build-info.json` is stamped by deploy/gen-build-info.sh at release
// time and baked into the image. This plugin reads it once and exposes it as
// the `/version` command plus one line of system prompt, so both the operator
// and the model know exactly which fork build is answering.
import { readFileSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'

export const name = 'ext-version'

export const Config = z.object({
  /** Where the release stamp lives inside the container. */
  buildInfoPath: z.string().default('/opt/dsh/build-info.json'),
  /** Add one line to the system prompt naming the build. */
  announceToModel: z.boolean().default(true),
})

const UNKNOWN = {
  forkVersion: 'unknown',
  forkCommit: 'unknown',
  upstreamBase: 'unknown',
  upstreamNpm: 'unknown',
  builtAt: 'unknown',
  repository: '',
  mirror: '',
  extensions: {},
}

/** Read and normalise the stamp; never throws — a missing file yields "unknown". */
export function readBuildInfo(path, read = readFileSync) {
  try {
    const parsed = JSON.parse(read(path, 'utf8'))
    return { ...UNKNOWN, ...parsed, extensions: parsed.extensions ?? {} }
  } catch {
    return { ...UNKNOWN }
  }
}

/** One-line identity, e.g. "dsh fork v1.0.0 (a1b2c3d) on upstream dsh-v0.1.5-rc.2". */
export function shortLine(info) {
  return `dsh fork v${info.forkVersion} (${info.forkCommit}) on upstream ${info.upstreamBase}`
}

export function report(info) {
  const exts = Object.entries(info.extensions)
  const lines = [
    `Fork version:   v${info.forkVersion}  (commit ${info.forkCommit}, built ${info.builtAt})`,
    `Upstream base:  ${info.upstreamBase}${info.upstreamNpm && info.upstreamNpm !== 'unknown' ? ` (npm @deepseek-ai/dsh@${info.upstreamNpm})` : ''}`,
  ]
  if (info.repository) lines.push(`Source:         ${info.repository}`)
  if (info.mirror) lines.push(`Mirror:         git clone ${info.mirror}`)
  lines.push(exts.length === 0
    ? 'Extensions:     (none recorded)'
    : `Extensions:     ${exts.map(([n, v]) => `${n}@${v}`).join(', ')}`)
  return lines.join('\n')
}

export function apply(ctx, config) {
  const info = readBuildInfo(config.buildInfoPath)

  if (config.announceToModel) {
    ctx.inject(['systemPrompt'], (pctx) => {
      pctx.effect(() => pctx.systemPrompt.section({
        name: 'ext:version',
        order: 20,
        text: `You are running ${shortLine(info)}. Its source, including your own plugins under extensions/, is at ${info.repository || 'the fork repository'}; the operator deploys changes with deploy/update.sh and cuts releases with deploy/release.sh.`,
      }))
    })
  }

  ctx.inject(['commands'], (cctx) => {
    cctx.effect(() => cctx.commands.register({
      name: 'version',
      description: 'Which build of this harness fork is running',
      recordInput: false,
      handler: () => ({ kind: 'success', text: report(info) }),
    }))
  })
}
