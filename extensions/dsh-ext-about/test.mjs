// Run inside the dsh container:
//   node --test /data/dsh/profiles/web/node_modules/dsh-ext-about/test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { escapeHtml, panelRows, parseChangelog, renderBody, renderPanel } from './about.js'

const changelog = `# Changelog

Intro prose that belongs to no release.

## v1.4.0 — 2026-09-21

Upstream base: \`dsh-v0.1.5-rc.2\`.

- **Dedup** of repeated results.
  A continuation line.
- \`/context\` shows the window.

## v1.0.0 — 2026-09-20

First release.
`

test('changelog parsing: releases, dates, bodies; prose outside a release is ignored', () => {
  const entries = parseChangelog(changelog)
  assert.deepEqual(entries.map((e) => e.version), ['1.4.0', '1.0.0'])
  assert.equal(entries[0].date, '2026-09-21')
  assert.match(entries[0].body, /Dedup/)
  assert.doesNotMatch(entries[0].body, /Intro prose/)
  assert.equal(entries[1].body, 'First release.')
  assert.deepEqual(parseChangelog(''), [])
})

test('body rendering: bullets, continuations, inline code and bold', () => {
  const html = renderBody(parseChangelog(changelog)[0].body)
  assert.match(html, /<ul><li>/)
  assert.match(html, /<strong>Dedup<\/strong>/)
  assert.match(html, /<code>\/context<\/code>/)
  assert.match(html, /A continuation line\.<\/li>/, 'a wrapped bullet line joins its bullet')
  assert.match(html, /<p>Upstream base: <code>dsh-v0\.1\.5-rc\.2<\/code>\.<\/p>/)
})

test('escaping: changelog text can never inject markup', () => {
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
  const html = renderBody('- a <script>bad()</' + 'script> b')
  assert.doesNotMatch(html, /<script/)
  assert.match(html, /&lt;script&gt;/)
})

test('panel: identity, extension list and release history', () => {
  const html = renderPanel({
    forkVersion: '1.4.0',
    forkCommit: 'abc1234567',
    upstreamBase: 'dsh-v0.1.5-rc.2',
    builtAt: '2026-09-21T12:00:00Z',
    repository: 'https://github.com/mirrorcoder/deepseek-harness',
    mirror: 'https://ds.jusl.me/git/deepseek-harness.git',
    extensions: { 'dsh-ext-about': '0.1.0' },
  }, parseChangelog(changelog))
  assert.match(html, /v1\.4\.0/)
  assert.match(html, /dsh-v0\.1\.5-rc\.2/)
  assert.match(html, /abc1234567/)
  assert.match(html, /dsh-ext-about/)
  assert.match(html, /github\.com\/mirrorcoder/)
  assert.match(html, /<h3>v1\.0\.0/)
})

test('panel degrades when the build stamp is missing', () => {
  const html = renderPanel({}, [])
  assert.match(html, /v?unknown/)
  assert.match(html, /No extensions recorded/)
  assert.match(html, /No changelog was baked/)
})

test('rows: one style, one body html, one body script, and no script-closing text', () => {
  const rows = panelRows({ forkVersion: '1.4.0', extensions: {} }, parseChangelog(changelog))
  assert.deepEqual(rows.map((r) => r.kind), ['style', 'html', 'script'])
  assert.equal(rows[1].placement, 'body')
  assert.equal(rows[2].placement, 'body')
  for (const row of rows) {
    const text = row.text ?? row.html
    assert.doesNotMatch(text, /<\/script/i, 'an inline row must not close the script element')
    assert.doesNotMatch(text, /<\/style/i)
  }
  assert.match(rows[1].html, /id="dsh-about-open"/)
  assert.match(rows[2].text, /addEventListener\('keydown'/)
})
