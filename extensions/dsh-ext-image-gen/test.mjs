// Run inside the dsh container:
//   node --test /data/dsh/profiles/web/node_modules/dsh-ext-image-gen/test.mjs
// Spins up a fake gateway on a unix socket and checks the client contract.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { completeWithImages, health } from './gateway.js'
import { buildPrompt } from './index.js'

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

function fakeGateway(handler) {
  const sock = join(tmpdir(), `imggw-test-${process.pid}-${Math.random().toString(36).slice(2)}.sock`)
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => handler(req, body, res))
  })
  return new Promise((resolve) => server.listen(sock, () => resolve({ sock, close: () => server.close() })))
}

test('completeWithImages: sends the gateway contract and decodes images', async () => {
  let seen
  const gw = await fakeGateway((req, body, res) => {
    seen = { auth: req.headers.authorization, json: JSON.parse(body), path: req.url }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ version: 1, ok: true, text: 'done', model: 'codex-subscription', images: [{ media_type: 'image/png', data: PNG.toString('base64'), width: 1, height: 1 }] }))
  })
  try {
    const out = await completeWithImages({ socketPath: gw.sock, token: 't0k', prompt: 'a cat', deadlineMs: 1234 })
    assert.equal(seen.path, '/v1/complete')
    assert.equal(seen.auth, 'Bearer t0k')
    assert.equal(seen.json.version, 1)
    assert.equal(seen.json.engine, 'codex')
    assert.equal(seen.json.want_images, true)
    assert.equal(seen.json.deadline_ms, 1234)
    assert.match(seen.json.request_id, /^[0-9a-f-]{36}$/)
    assert.deepEqual(Object.keys(seen.json).sort(), ['deadline_ms', 'engine', 'prompt', 'request_id', 'version', 'want_images'])
    assert.equal(out.text, 'done')
    assert.equal(out.images.length, 1)
    assert.equal(out.images[0].width, 1)
    assert.ok(out.images[0].data.equals(PNG))
  } finally { gw.close() }
})

test('completeWithImages: surfaces gateway error codes', async () => {
  const gw = await fakeGateway((_req, _body, res) => {
    res.statusCode = 503
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ version: 1, ok: false, error: { code: 'engine_unavailable' } }))
  })
  try {
    await assert.rejects(completeWithImages({ socketPath: gw.sock, token: 't', prompt: 'x' }), /engine_unavailable/)
  } finally { gw.close() }
})

test('completeWithImages: non-JSON body is an error, not a crash', async () => {
  const gw = await fakeGateway((_req, _body, res) => { res.statusCode = 502; res.end('Bad Gateway') })
  try {
    await assert.rejects(completeWithImages({ socketPath: gw.sock, token: 't', prompt: 'x' }), /HTTP 502 non-JSON/)
  } finally { gw.close() }
})

test('health passes the bearer and parses json', async () => {
  const gw = await fakeGateway((req, _body, res) => {
    assert.equal(req.url, '/healthz')
    res.end(JSON.stringify({ ok: true, engines: { codex: { available: true } } }))
  })
  try {
    const h = await health({ socketPath: gw.sock, token: 't' })
    assert.equal(h.engines.codex.available, true)
  } finally { gw.close() }
})

test('buildPrompt asks for the image tool and a terse reply', () => {
  const p = buildPrompt('a red fox in snow', 2)
  assert.match(p, /image_generation/)
  assert.match(p, /2 distinct image variants/)
  assert.match(p, /a red fox in snow/)
  assert.match(p, /single word: done/)
})
