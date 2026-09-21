// dsh-ext-about — a small "i" button that opens what this fork adds and when.
//
// The Web UI's own panels are React plugins built inside the monorepo, which a
// package installed from outside it cannot produce. The page itself, though, is
// assembled from structured injection rows, and that seam is enough for one
// self-contained overlay: scoped styles, a button, a dialog, and a few lines of
// vanilla script. It touches nothing the app owns — every class and id is
// prefixed, and the dialog lives in its own layer.
//
// Content comes from the release stamp baked into the image plus our
// CHANGELOG, both read once at boot.
import { readFileSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'
import { panelRows, parseChangelog } from './about.js'

export const name = 'ext-about'
export const inject = ['webServer']

export const Config = z.object({
  enabled: z.boolean().default(true),
  /** Release stamp written by deploy/gen-build-info.sh. */
  buildInfoPath: z.string().default('/opt/dsh/build-info.json'),
  /** Our changelog, baked into the image next to it. */
  changelogPath: z.string().default('/opt/dsh/CHANGELOG.md'),
  /** Releases listed in the panel, newest first. */
  maxReleases: z.number().default(12),
})

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

export function apply(ctx, config) {
  if (!config.enabled) return
  const info = readJson(config.buildInfoPath)
  const entries = parseChangelog(readText(config.changelogPath)).slice(0, config.maxReleases)
  const rows = panelRows(info, entries)
  ctx.on('webserver/index-inject', (table) => {
    for (const row of rows) table.push(row)
  })
}
