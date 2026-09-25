// Downloads. Run inside the dsh container:
//   node --test /data/dsh/profiles/web/node_modules/dsh-ext-files/test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Script } from 'node:vm'
import { contentDisposition, contentTypeOf, insideAny } from './download.js'
import { serveDownload } from './index.js'
import { filesRows, filesScript } from './client.js'

test('a path is inside a root only below it, never beside it', () => {
  assert.ok(insideAny('/workspace/projects/книга/a.docx', ['/workspace']))
  assert.ok(insideAny('/workspace', ['/workspace']))
  assert.ok(!insideAny('/workspace2/a.txt', ['/workspace']), 'a sibling sharing the prefix is not inside')
  assert.ok(!insideAny('/data/dsh/.credentials.yaml', ['/workspace', '/host/root/aisignals']))
})

test('a Cyrillic file name arrives intact, with an ASCII fallback', () => {
  const header = contentDisposition('Глава_3_новая_редакция.docx')
  assert.match(header, /^attachment; filename="download\.docx"; filename\*=UTF-8''/)
  const encoded = header.split("filename*=UTF-8''")[1]
  assert.equal(decodeURIComponent(encoded), 'Глава_3_новая_редакция.docx')
  assert.equal(contentDisposition('report.pdf'), `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`)
  assert.doesNotMatch(contentDisposition('a"b.txt'), /filename="a"b/, 'a quote cannot end the header value early')
})

test('the type follows the extension, unknown ones download as bytes', () => {
  assert.match(contentTypeOf('Глава.DOCX'), /wordprocessingml/)
  assert.equal(contentTypeOf('data.bin'), 'application/octet-stream')
})

const get = (path, method = 'GET') => new Request(`http://local/api/files/download?path=${encodeURIComponent(path)}`, { method })

test('the route serves a workspace file and refuses everything else', async () => {
  const base = await mkdtemp(join(tmpdir(), 'files-test-'))
  const root = join(base, 'workspace')
  const outside = join(base, 'secret.txt')
  const book = join(root, 'projects', 'книга')
  try {
    await mkdir(book, { recursive: true })
    await writeFile(join(book, 'Глава_3.docx'), 'содержимое главы')
    await writeFile(outside, 'не отдавать')
    await symlink(outside, join(book, 'link-out.txt'))

    const ok = await serveDownload(get(join(book, 'Глава_3.docx')), [root])
    assert.equal(ok.status, 200)
    assert.equal(await ok.text(), 'содержимое главы')
    assert.equal(ok.headers.get('content-length'), String(Buffer.byteLength('содержимое главы')))
    assert.match(ok.headers.get('content-disposition'), /filename\*=UTF-8''%D0%93/)

    const head = await serveDownload(get(join(book, 'Глава_3.docx'), 'HEAD'), [root])
    assert.equal(head.status, 200)
    assert.equal(head.body, null)

    assert.equal((await serveDownload(get('projects/книга/Глава_3.docx'), [root])).status, 400, 'relative path')
    assert.equal((await serveDownload(get(join(book, 'нет.docx')), [root])).status, 404, 'missing file')
    assert.equal((await serveDownload(get(outside), [root])).status, 403, 'outside every root')
    assert.equal((await serveDownload(get(join(book, '..', '..', '..', 'secret.txt')), [root])).status, 403, '.. out of the root')
    assert.equal((await serveDownload(get(join(book, 'link-out.txt')), [root])).status, 403, 'a symlink out of the root')
    assert.equal((await serveDownload(get(book), [root])).status, 400, 'a directory is not a file')
    assert.equal((await serveDownload(get(join(book, 'Глава_3.docx')), [join(base, 'нет-такого')])).status, 403, 'a missing root allows nothing')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('the page script parses and ships with its stylesheet', () => {
  assert.doesNotThrow(() => new Script(filesScript()))
  const rows = filesRows()
  assert.deepEqual(rows.map((row) => row.kind), ['style', 'script'])
  assert.match(rows[0].text, /pointer-events:auto/, 'the card ignores the pointer under its buttons')
  assert.match(filesScript(), /\[data-presented-file\]/)
})
