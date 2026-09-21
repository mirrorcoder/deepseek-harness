// Run inside the dsh container:
//   node --test /data/dsh/profiles/web/node_modules/dsh-ext-version/test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readBuildInfo, report, shortLine } from './index.js'

const file = {
  forkVersion: '1.2.3',
  upstreamBase: 'dsh-v0.1.5-rc.2',
  upstreamNpm: '0.1.5-rc.2',
  releasedAt: '2026-09-21',
  repository: 'https://github.com/mirrorcoder/deepseek-harness',
  mirror: 'https://ds.jusl.me/git/deepseek-harness.git',
  extensions: { 'dsh-ext-image-gen': '0.1.0', 'dsh-ext-version': '0.1.0' },
}
const env = { DSH_FORK_COMMIT: 'abc1234567', DSH_BUILT_AT: '2026-09-21T12:00:00Z' }
const stamp = readBuildInfo('/x', () => JSON.stringify(file), env)

test('reads the file and takes commit/build time from the environment', () => {
  assert.equal(stamp.forkVersion, '1.2.3')
  assert.equal(stamp.forkCommit, 'abc1234567')
  assert.equal(stamp.builtAt, '2026-09-21T12:00:00Z')
  assert.deepEqual(Object.keys(stamp.extensions), ['dsh-ext-image-gen', 'dsh-ext-version'])
})

test('environment wins over a stale commit left in the file', () => {
  const info = readBuildInfo('/x', () => JSON.stringify({ ...file, forkCommit: 'dangling00' }), env)
  assert.equal(info.forkCommit, 'abc1234567')
})

test('a missing or corrupt stamp degrades to unknown instead of throwing', () => {
  const missing = readBuildInfo('/nope', () => { throw new Error('ENOENT') }, {})
  assert.equal(missing.forkVersion, 'unknown')
  assert.equal(missing.forkCommit, 'unknown')
  assert.deepEqual(missing.extensions, {})
  assert.equal(readBuildInfo('/bad', () => 'not json', {}).forkVersion, 'unknown')
  assert.doesNotThrow(() => report(readBuildInfo('/nope', () => { throw new Error('x') }, {})))
})

test('partial stamp keeps known fields and fills the rest', () => {
  const info = readBuildInfo('/p', () => JSON.stringify({ forkVersion: '9.9.9' }), {})
  assert.equal(info.forkVersion, '9.9.9')
  assert.equal(info.upstreamBase, 'unknown')
})

test('short line names fork version, commit and upstream base', () => {
  assert.equal(shortLine(stamp), 'dsh fork v1.2.3 (abc1234567) on upstream dsh-v0.1.5-rc.2')
})

test('report lists versions, source, mirror and extensions', () => {
  const text = report(stamp)
  assert.match(text, /v1\.2\.3/)
  assert.match(text, /released 2026-09-21/)
  assert.match(text, /dsh-v0\.1\.5-rc\.2/)
  assert.match(text, /npm @deepseek-ai\/dsh@0\.1\.5-rc\.2/)
  assert.match(text, /git clone https:\/\/ds\.jusl\.me\/git\/deepseek-harness\.git/)
  assert.match(text, /dsh-ext-image-gen@0\.1\.0/)
  assert.match(report({ ...stamp, extensions: {} }), /\(none recorded\)/)
})
