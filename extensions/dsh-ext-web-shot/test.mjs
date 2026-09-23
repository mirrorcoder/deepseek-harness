// Screenshots and page text. Run inside the dsh container:
//   node --test /data/dsh/profiles/web/node_modules/dsh-ext-web-shot/test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkUrl, domArgs, htmlToText, screenshotArgs, slugOf } from './shot.js'

test('only web pages may be opened, never the container through file://', () => {
  assert.equal(checkUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1')
  assert.throws(() => checkUrl('file:///etc/passwd'), /only http and https/)
  assert.throws(() => checkUrl('chrome://settings'), /only http and https/)
  assert.throws(() => checkUrl('не адрес'), /not a URL/)
})

test('the screenshot command carries the size, the wait and a private profile', () => {
  const args = screenshotArgs('https://x.test/', { out: '/tmp/a.png', profileDir: '/tmp/p', width: 390, height: 844, waitMs: 1500 })
  assert.ok(args.includes('--window-size=390,844'))
  assert.ok(args.includes('--screenshot=/tmp/a.png'))
  assert.ok(args.includes('--virtual-time-budget=1500'))
  assert.ok(args.includes('--user-data-dir=/tmp/p'))
  assert.equal(args.at(-1), 'https://x.test/', 'адрес последним — после всех флагов')
})

test('sizes and waits are clamped, not trusted', () => {
  const args = screenshotArgs('https://x.test/', { out: '/o', profileDir: '/p', width: 99999, height: 1, waitMs: 999999 })
  assert.ok(args.includes('--window-size=2560,240'))
  assert.ok(args.includes('--virtual-time-budget=20000'))
  assert.ok(domArgs('https://x.test/', { profileDir: '/p' }).includes('--dump-dom'))
})

test('page text is what a reader sees: title, words, no scripts', () => {
  const { title, text } = htmlToText(`
    <html><head><title>AI Pulse</title><style>.a{color:red}</style></head>
    <body><script>var secret = 1</script><h1>Сигналы</h1><p>Цена&nbsp;$10 &amp; выше</p><div>строка<br>вторая</div></body></html>`)
  assert.equal(title, 'AI Pulse')
  assert.match(text, /Сигналы/)
  assert.match(text, /Цена \$10 & выше/)
  assert.match(text, /строка\nвторая/)
  assert.doesNotMatch(text, /secret|color:red/)
})

test('a huge page is cut, and says it was cut', () => {
  const { text } = htmlToText(`<p>${'слово '.repeat(10_000)}</p>`, 500)
  assert.ok(text.length < 600)
  assert.match(text, /обрезано/)
})

test('file names come from the address, safely', () => {
  assert.equal(slugOf('https://ds.jusl.me/git/repo'), 'ds.jusl.me-git-repo')
  assert.equal(slugOf('не адрес'), 'page')
})
