// Memory across sessions. Run inside the dsh container:
//   node --test /data/dsh/profiles/web/node_modules/dsh-ext-memory/test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileNameOf, listNotes, nameOf, renderNotes, slugOf } from './notes.js'

test('a workspace path becomes one safe directory name', () => {
  assert.equal(slugOf('/workspace/projects/justtest'), 'workspace-projects-justtest')
  assert.equal(slugOf('/root/aisignals/'), 'root-aisignals')
  assert.equal(slugOf('/'), 'root')
  assert.equal(slugOf(''), 'root')
  assert.equal(slugOf('/tmp/../etc'), 'tmp-..-etc')
})

test('a note name can never become a path', () => {
  assert.equal(fileNameOf('deploy command'), 'deploy-command.md')
  assert.equal(fileNameOf('../../etc/passwd'), 'etc-passwd.md')
  assert.equal(fileNameOf('/absolute'), 'absolute.md')
  // A name that is nothing but path syntax is a refusal, not a file called "..".
  assert.throws(() => fileNameOf('..'), /must contain/)
  assert.throws(() => fileNameOf('   '), /must contain/)
  assert.equal(nameOf('prod-host.md'), 'prod-host')
})

const note = (name, body, changedAt) => ({ name: `${name}.md`, body, changedAt })

test('the section is newest first, because a budget cuts the tail', () => {
  const text = renderNotes([
    note('old', 'старый факт', 1),
    note('new', 'новый факт', 9),
  ])
  assert.ok(text.indexOf('новый факт') < text.indexOf('старый факт'))
  assert.match(text, /## Memory/)
  assert.match(text, /### new/)
})

test('a note that does not fit is dropped whole, and the drop is admitted', () => {
  const text = renderNotes([
    note('huge', 'x'.repeat(5000), 1),
    note('small', 'помещается', 9),
  ], { maxChars: 300 })
  assert.match(text, /помещается/)
  assert.doesNotMatch(text, /xxxx/, 'половина факта читается как целый факт')
  assert.match(text, /1 older note/)
})

test('no notes means no section at all, not an empty heading', () => {
  assert.equal(renderNotes([]), '')
  assert.equal(renderNotes([note('blank', '   ', 1)]), '')
  assert.equal(renderNotes(undefined), '')
})

test('the section stays inside its budget', () => {
  const many = []
  for (let i = 0; i < 50; i += 1) many.push(note(`n${i}`, 'факт '.repeat(60), i))
  const text = renderNotes(many, { maxChars: 2000 })
  assert.ok(text.length <= 2200, `бюджет: ${text.length}`)
})

test('the listing is one line per note, newest first', () => {
  const text = listNotes([note('a', 'раз', 1), note('b', 'два', 5)])
  assert.match(text.split('\n')[0], /- b/)
  assert.match(listNotes([]), /пока нет/)
})
