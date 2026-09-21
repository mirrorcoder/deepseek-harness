// Markdown → Telegram HTML. Run inside the dsh container:
//   node --test /data/dsh/profiles/web/node_modules/dsh-ext-telegram/test-markdown.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { plainInline, renderTable, splitRow, toTelegramHtml } from './markdown.js'

test('headings become bold lines, bullets become dots, rules disappear', () => {
  assert.equal(toTelegramHtml('## Итоги'), '<b>Итоги</b>')
  assert.equal(toTelegramHtml('- первый\n* второй\n+ третий'), '• первый\n• второй\n• третий')
  assert.equal(toTelegramHtml('текст\n\n---\n\nещё'), 'текст\n\n\nещё')
  assert.equal(toTelegramHtml('  - вложенный'), '  • вложенный')
})

test('inline marks become the tags Telegram renders', () => {
  assert.equal(toTelegramHtml('**жирный** и *курсив* и `код`'), '<b>жирный</b> и <i>курсив</i> и <code>код</code>')
  assert.equal(toTelegramHtml('~~вычеркнуто~~'), '<s>вычеркнуто</s>')
  assert.equal(toTelegramHtml('[ссылка](https://ds.jusl.me)'), '<a href="https://ds.jusl.me">ссылка</a>')
  assert.equal(toTelegramHtml('> цитата'), '<blockquote>цитата</blockquote>')
  // an underscore inside a word is not italics: file_path must survive
  assert.equal(toTelegramHtml('file_path_here'), 'file_path_here')
})

test('everything the model wrote is escaped, so markup cannot leak', () => {
  assert.equal(toTelegramHtml('a < b & c > d'), 'a &lt; b &amp; c &gt; d')
  assert.match(toTelegramHtml('```\n<script>alert(1)</script>\n```'), /&lt;script&gt;/)
  assert.doesNotMatch(toTelegramHtml('**<b>жирный</b>**'), /<b>жирный<\/b><\/b>/)
})

test('fences become pre blocks, and an unclosed one still renders', () => {
  assert.equal(toTelegramHtml('```js\nconst x = 1\n```'), '<pre>const x = 1</pre>')
  // mid-stream the closing fence has not arrived yet
  assert.equal(toTelegramHtml('```\nнедописано'), '<pre>недописано</pre>')
  assert.match(toTelegramHtml('до\n```\nкод\n```\nпосле'), /^до\n<pre>код<\/pre>\nпосле$/)
})

test('a table becomes an aligned monospace block, markers dropped inside it', () => {
  const html = toTelegramHtml('| Источник | Оценка |\n|---|---|\n| Схемы | **много** |\n| `файлы` | 7к |')
  assert.match(html, /^<pre>/)
  const body = html.replace(/<\/?pre>/g, '')
  const [head, rule, first] = body.split('\n')
  assert.match(head, /^Источник  Оценка$/)
  assert.match(rule, /^─+ {2}─+$/)
  assert.equal(head.indexOf('Оценка'), first.indexOf('много'), 'columns line up')
  assert.doesNotMatch(body, /\*\*/)
  assert.doesNotMatch(body, /`/)
})

test('a wide cell is clipped so the table stays readable on a phone', () => {
  const html = renderTable(['| a | b |', `| ${'x'.repeat(80)} | y |`], 20)
  const widest = Math.max(...html.replace(/<\/?pre>/g, '').split('\n').map((line) => [...line].length))
  assert.ok(widest <= 20 + 2 + 20, `a row must not run away: ${widest}`)
  assert.match(html, /…/)
})

test('a single pipe line is not a table', () => {
  assert.equal(toTelegramHtml('| одна строка |'), '| одна строка |')
})

test('helpers: row splitting tolerates missing pipes, cells lose their markers', () => {
  assert.deepEqual(splitRow('| a | b |'), ['a', 'b'])
  assert.deepEqual(splitRow('a | b'), ['a', 'b'])
  assert.equal(plainInline('**жирный** `код` [текст](https://x.dev) *курсив*'), 'жирный код текст курсив')
})

test('the shape a real answer arrives in survives the round trip', () => {
  const answer = [
    '## Что сделано',
    '',
    '| Файл | Строк |',
    '|---|---|',
    '| `index.js` | 420 |',
    '',
    '- правка **первая**',
    '- правка вторая',
    '',
    '```sh',
    'pnpm test',
    '```',
  ].join('\n')
  const html = toTelegramHtml(answer)
  assert.match(html, /<b>Что сделано<\/b>/)
  assert.match(html, /<pre>Файл {6}Строк/)
  assert.match(html, /• правка <b>первая<\/b>/)
  assert.match(html, /<pre>pnpm test<\/pre>/)
  assert.doesNotMatch(html, /\|/)
})
