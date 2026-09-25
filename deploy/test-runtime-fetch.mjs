// The built-in fetch must survive the undici the runtime ships. Runs inside the
// dsh container (update.sh does it after every deploy):
//   node --test /opt/dsh/test-runtime-fetch.mjs
//
// Importing npm undici 8 (dsh-http-proxy does) installs its Agent as the
// process-wide dispatcher, and Node 22's built-in fetch — undici 6 — reaches
// it through a legacy wrapper. With undici 8.11.0 that wrapper handed fetch no
// response headers over HTTP/2: DeepSeek's brotli search replies stayed
// compressed ("Unexpected token 'e'") and web_search failed on every call.
// This reproduces that offline: a local HTTP/2 server answering in brotli.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSecureServer } from 'node:http2'
import { brotliCompressSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const RUNTIME = process.env.DSH_RUNTIME_DIR ?? '/opt/dsh-runtime'

function selfSigned() {
  const dir = mkdtempSync(join(tmpdir(), 'fetch-test-'))
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' })
    return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('built-in fetch decodes a brotli reply over HTTP/2 through the runtime undici', async () => {
  const require = createRequire(join(RUNTIME, 'package.json'))
  const undici = await import(require.resolve('undici'))
  const body = JSON.stringify({ content: [{ type: 'web_search_tool_result', padding: 'x'.repeat(4000) }] })
  const server = createSecureServer({ ...selfSigned(), allowHTTP1: true }, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'br' })
    res.end(brotliCompressSync(body))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const previous = undici.getGlobalDispatcher()
  // The same kind of Agent undici installs on import, trusting the test certificate.
  undici.setGlobalDispatcher(new undici.Agent({ connect: { rejectUnauthorized: false } }))
  try {
    const response = await fetch(`https://127.0.0.1:${server.address().port}/`)
    assert.equal(response.headers.get('content-type'), 'application/json', `undici ${require('undici/package.json').version} lost the response headers`)
    assert.deepEqual(await response.json(), JSON.parse(body))
  } finally {
    undici.setGlobalDispatcher(previous)
    server.close()
  }
})
