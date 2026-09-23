// Screenshots and page text. Run inside the dsh container:
//   node --test /data/dsh/profiles/web/node_modules/dsh-ext-web-shot/test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { capture, checkUrl, clamp, devtoolsUrl, launchArgs, slugOf, tidyText } from './shot.js'

test('only web pages may be opened, never the container through file://', () => {
  assert.equal(checkUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1')
  assert.throws(() => checkUrl('file:///etc/passwd'), /only http and https/)
  assert.throws(() => checkUrl('chrome://settings'), /only http and https/)
  assert.throws(() => checkUrl('не адрес'), /not a URL/)
})

test('the browser starts headless, in a private profile, with a DevTools port', () => {
  const args = launchArgs('/tmp/p')
  assert.ok(args.includes('--headless=new'))
  assert.ok(args.includes('--user-data-dir=/tmp/p'))
  assert.ok(args.includes('--remote-debugging-port=0'))
  assert.ok(!args.some((a) => a.startsWith('--virtual-time-budget')), 'виртуальное время вешает страницы с открытым соединением')
})

test('the DevTools address is read from what Chromium prints on start', () => {
  const line = '\nDevTools listening on ws://127.0.0.1:41234/devtools/browser/abc-123\n'
  assert.equal(devtoolsUrl(line), 'ws://127.0.0.1:41234/devtools/browser/abc-123')
  assert.equal(devtoolsUrl('nothing here'), undefined)
})

test('sizes and waits are clamped, not trusted', () => {
  assert.equal(clamp(99999, 320, 2560, 1280), 2560)
  assert.equal(clamp('x', 320, 2560, 1280), 1280)
  assert.equal(clamp(-5, 0, 20000, 3000), 0)
})

test('page text is tidied and a huge page is cut, saying so', () => {
  assert.equal(tidyText('  Сигналы \n\n\n\n  Цена $10  '), 'Сигналы\n\nЦена $10')
  const long = tidyText('слово '.repeat(10_000), 500)
  assert.ok(long.length < 600)
  assert.match(long, /обрезано/)
})

test('file names come from the address, safely', () => {
  assert.equal(slugOf('https://ds.jusl.me/git/repo'), 'ds.jusl.me-git-repo')
  assert.equal(slugOf('не адрес'), 'page')
})

// ── with a real browser, when this image has one ─────────────────────────────
const hasChromium = spawnSync('sh', ['-c', 'command -v chromium'], { encoding: 'utf8' }).status === 0

/** A page that renders its text from a script AND keeps an SSE stream open forever. */
function liveServer() {
  const server = createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      res.write('data: hello\n\n') // and never end
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><title>Живая страница</title><body><div id="x">загрузка…</div>
      <script>new EventSource('/events'); setTimeout(() => { document.getElementById('x').textContent = 'Отрисовано скриптом' }, 300)</script>`)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

test('a page that keeps a connection open is still captured, after its scripts ran', { skip: !hasChromium }, async () => {
  // The first version hung here until its timeout: virtual time never advances
  // while an SSE stream is open, and the harness's own UI holds one.
  const server = await liveServer()
  const url = `http://127.0.0.1:${server.address().port}/`
  const profileDir = await mkdtemp(join(tmpdir(), 'shot-test-'))
  try {
    const started = Date.now()
    const page = await capture(url, { binary: 'chromium', profileDir, mode: 'text', waitMs: 1000, timeoutMs: 30_000 })
    assert.ok(Date.now() - started < 20_000, `слишком долго: ${Date.now() - started} мс`)
    assert.equal(page.status, 200)
    assert.equal(page.title, 'Живая страница')
    assert.match(page.text, /Отрисовано скриптом/, 'текст берётся ПОСЛЕ того, как скрипт страницы отработал')

    const shot = await capture(url, { binary: 'chromium', profileDir, mode: 'screenshot', width: 390, height: 600, waitMs: 500 })
    assert.equal(shot.png.subarray(1, 4).toString('ascii'), 'PNG')
    assert.equal(shot.png.readUInt32BE(16), 390, 'ширина снимка = заданной')
  } finally {
    server.closeAllConnections()
    server.close()
    await rm(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})

test('a page that does not answer at all fails with a readable reason, not a hang', { skip: !hasChromium }, async () => {
  const profileDir = await mkdtemp(join(tmpdir(), 'shot-test-'))
  try {
    await assert.rejects(
      capture('http://127.0.0.1:9/', { binary: 'chromium', profileDir, mode: 'text', waitMs: 0, timeoutMs: 20_000 }),
      /did not open|ERR_/,
    )
  } finally {
    await rm(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})
