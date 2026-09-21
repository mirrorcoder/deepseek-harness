// Run inside the dsh container:
//   node --test /data/dsh/profiles/web/node_modules/dsh-ext-workspace-picker/test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyNoise, DEFAULT_NOISE, homeAnchorPath, landingPath, mergePlaces } from './policy.js'

const row = (name, path, hidden = false) => ({ name, path, hidden })

test('landing: explicit request wins, then config, then cwd', () => {
  assert.equal(landingPath('/etc', '/workspace', '/workspace'), '/etc')
  assert.equal(landingPath(undefined, '/srv/code', '/workspace'), '/srv/code')
  assert.equal(landingPath(undefined, '', '/workspace'), '/workspace')
  // no config and no cwd: let the backend apply its own default (home)
  assert.equal(landingPath(undefined, '', ''), undefined)
})

test('home anchor is one fixed place, never the level being listed', () => {
  assert.equal(homeAnchorPath('/pinned', '/workspace', '/workspace'), '/pinned')
  assert.equal(homeAnchorPath('', '/srv/code', '/workspace'), '/srv/code')
  assert.equal(homeAnchorPath('', '', '/workspace'), '/workspace')
  // nothing configured: the backend's own home value stands
  assert.equal(homeAnchorPath('', '', ''), undefined)
})

test('noise: build output and caches are dimmed, real project dirs are not', () => {
  assert.equal(applyNoise(row('node_modules', '/w/node_modules'), DEFAULT_NOISE).hidden, true)
  assert.equal(applyNoise(row('dist', '/w/dist'), DEFAULT_NOISE).hidden, true)
  assert.equal(applyNoise(row('src', '/w/src'), DEFAULT_NOISE).hidden, false)
  assert.equal(applyNoise(row('projects', '/w/projects'), DEFAULT_NOISE).hidden, false)
})

test('noise: an already hidden row stays hidden and the row is not mutated', () => {
  const original = row('.config', '/w/.config', true)
  const flagged = applyNoise(original, DEFAULT_NOISE)
  assert.equal(flagged.hidden, true)
  const dimmed = applyNoise(row('.git', '/w/.git'), DEFAULT_NOISE)
  assert.equal(dimmed.hidden, true)
  assert.notEqual(dimmed, original)
  assert.equal(original.hidden, true)
})

test('noise: an empty list dims nothing', () => {
  assert.equal(applyNoise(row('node_modules', '/w/node_modules'), []).hidden, false)
})

test('places: prepended as jump rows, never duplicating a real child or the level itself', () => {
  const entries = [row('deepseek-harness', '/workspace/deepseek-harness'), row('projects', '/workspace/projects')]
  const merged = mergePlaces(entries, [
    { name: 'harness data', path: '/data/dsh' },
    { name: 'deepseek-harness', path: '/workspace/deepseek-harness' }, // already a child
    { name: 'workspace', path: '/workspace' }, // the level being listed
  ], '/workspace')
  assert.deepEqual(merged.map((e) => e.path), ['/data/dsh', '/workspace/deepseek-harness', '/workspace/projects'])
  assert.equal(merged[0].hidden, false)
})

test('places: two places pointing at the same path yield one row; none means untouched entries', () => {
  const entries = [row('src', '/w/src')]
  const merged = mergePlaces(entries, [{ name: 'a', path: '/x' }, { name: 'b', path: '/x' }], '/w')
  assert.deepEqual(merged.map((e) => e.name), ['a', 'src'])
  assert.deepEqual(mergePlaces(entries, [], '/w'), entries)
})
