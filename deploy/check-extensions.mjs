#!/usr/bin/env node
// Every file an extension imports must be shipped by that extension's package.
//
// Our bundles are installed with `dsh plugin add file:…`, and pnpm copies only
// what package.json `files` lists. A module missing from that list is not a
// build error, not a test failure — the tests import pure modules and pass —
// and not even a boot error: the plugin that imports it silently fails to
// mount. That is exactly how v1.21.0 took the Telegram bridge down for ten
// minutes: `voice.js` existed in the repository and in the image, and was not
// in the list, so the installed bridge could not load.
//
// Usage: node deploy/check-extensions.mjs [extensions-dir]   (exit 1 on a gap)
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'

const IMPORT = /(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g
// A file read at runtime next to the module (`new URL('./x', import.meta.url)`)
// is just as missing when it is not shipped — and fails just as silently.
const URL_REF = /new URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g

/** Relative specifiers a module imports or reads beside itself. */
export function relativeImports(source) {
  const found = []
  for (const match of source.matchAll(IMPORT)) found.push(match[1] ?? match[2])
  for (const match of source.matchAll(URL_REF)) found.push(match[1])
  return found
}

/** Whether `file` (relative to the package) is covered by a `files` entry. */
export function shipped(file, files) {
  const target = normalize(file)
  return files.some((entry) => {
    const e = normalize(entry).replace(/\/$/, '')
    return target === e || target.startsWith(`${e}/`)
  })
}

/** Problems in one package directory, as readable lines. */
export function checkPackage(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const files = manifest.files
  if (!Array.isArray(files)) return [] // no list: npm ships everything
  const problems = []
  const main = manifest.main ?? 'index.js'
  if (!shipped(main, files)) problems.push(`main "${main}" is not in "files"`)
  const patch = manifest.dsh?.bundle?.patch
  if (typeof patch === 'string' && !shipped(patch.replace(/^\.\//, ''), files)) {
    problems.push(`bundle patch "${patch}" is not in "files"`)
  }
  const queue = [main]
  const seen = new Set()
  while (queue.length > 0) {
    const file = normalize(queue.shift())
    if (seen.has(file)) continue
    seen.add(file)
    const path = join(dir, file)
    if (!existsSync(path) || statSync(path).isDirectory()) continue
    for (const spec of relativeImports(readFileSync(path, 'utf8'))) {
      const target = normalize(join(dirname(file), spec))
      if (target.startsWith('..')) continue
      if (!shipped(target, files)) problems.push(`${file} imports "${spec}", which is not in "files"`)
      queue.push(target)
    }
  }
  return problems
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.argv[2] ?? join(dirname(process.argv[1]), '..', 'extensions')
  let bad = 0
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name)
    if (!existsSync(join(dir, 'package.json'))) continue
    for (const problem of checkPackage(dir)) {
      bad += 1
      process.stderr.write(`!! ${relative(process.cwd(), dir)}: ${problem}\n`)
    }
  }
  if (bad > 0) {
    process.stderr.write(`!! ${bad} file(s) would be missing from the installed extensions — fix "files" before building\n`)
    process.exit(1)
  }
  process.stdout.write('   ✓ every extension ships what it imports\n')
}
