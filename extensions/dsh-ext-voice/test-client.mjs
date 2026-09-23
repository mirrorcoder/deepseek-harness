// The page side of dictation. Run inside the dsh container:
//   node --test /data/dsh/profiles/web/node_modules/dsh-ext-voice/test-client.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { CSS, micScript, voiceRows } from './client.js'

test('the page gets a stylesheet and the dictation script, nothing else', () => {
  const rows = voiceRows()
  assert.deepEqual(rows.map((row) => row.kind), ['style', 'script'])
  assert.equal(rows[1].placement, 'body')
  assert.match(CSS, /\.dsh-mic\[data-state="recording"\]/)
})

test('the script parses as a browser script', () => {
  // Compiling is enough to catch a syntax error that would silently kill the
  // whole injected block in the browser.
  assert.doesNotThrow(() => new vm.Script(micScript(), { filename: 'mic.browser.js' }))
})

test('the button is anchored on what the upstream composer does not rename', () => {
  const source = micScript()
  // the hidden file input next to the paperclip, not a hashed class or a label
  assert.match(source, /input\[type="file"\]\[multiple\]/)
  assert.match(source, /\[contenteditable/)
})

test('the recording is resampled to 16 kHz mono WAV in the browser', () => {
  const source = micScript()
  assert.match(source, /const RATE = 16000/)
  assert.match(source, /new OfflineAudioContext\(1,/)
  assert.match(source, /'RIFF'/)
  assert.match(source, /'audio\/wav'/)
})

test('the text lands in the editor and is not sent', () => {
  const source = micScript()
  assert.match(source, /execCommand\('insertText'/)
  assert.doesNotMatch(source, /requestSubmit|\.submit\(\)|key: 'Enter'/, 'диктовка вставляет текст, отправляет человек')
})

test('the first placement runs after every handler exists', () => {
  const source = micScript()
  // `place()` wires `toggle`; calling it before `const toggle` throws in the TDZ
  assert.ok(source.lastIndexOf('\n  place()') > source.indexOf('const toggle'), 'place() до объявления toggle')
})

test('an insertion is judged after the editor rendered, and never done twice', () => {
  const source = micScript()
  // The editor renders on its own tick: a synchronous check reads the old text,
  // "fails", and the fallback inserts the same words a second time.
  const insertBody = source.slice(source.indexOf('const insert = async'), source.indexOf('// ── start'))
  const execAt = insertBody.indexOf("execCommand('insertText'")
  const firstSettle = insertBody.indexOf('await settle()', execAt)
  const pasteAt = insertBody.indexOf("new ClipboardEvent('paste'")
  assert.ok(execAt > 0 && firstSettle > execAt, 'после insertText ждём отрисовку')
  assert.ok(pasteAt > firstSettle, 'запасной путь только после проверки первого')
  assert.match(insertBody, /if \(\(editor\.textContent \|\| ''\) !== before\) return\n    try \{/, 'удалось — выходим, второй раз не вставляем')
  assert.match(source, /await insert\(text\)/)
})
