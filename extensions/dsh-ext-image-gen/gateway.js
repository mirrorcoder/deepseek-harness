// Minimal client for the smmprop LLM gateway (/v1/complete) over a unix socket
// or plain http. No dsh imports so it is testable with bare node.
import http from 'node:http'
import { randomUUID } from 'node:crypto'

function requestOptions(o, method, path) {
  const target = o.url && o.url.length > 0 ? new URL(o.url) : undefined
  return target
    ? { method, hostname: target.hostname, port: target.port || 80, path }
    : { method, socketPath: o.socketPath, path }
}

function send(req, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(req, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, raw: Buffer.concat(chunks).toString('utf8') }))
    })
    r.on('error', reject)
    r.end(body)
  })
}

/**
 * POST /v1/complete with want_images=true.
 * @param {{socketPath?: string, url?: string, token: string, prompt: string,
 *          engine?: string, deadlineMs?: number, signal?: AbortSignal}} o
 * @returns {Promise<{text: string, images: Array<{data: Buffer, mediaType: string, width: number, height: number}>}>}
 */
export async function completeWithImages(o) {
  const body = JSON.stringify({
    version: 1,
    request_id: randomUUID(),
    deadline_ms: o.deadlineMs ?? 280_000,
    engine: o.engine ?? 'codex',
    prompt: o.prompt,
    want_images: true,
  })
  const req = requestOptions(o, 'POST', '/v1/complete')
  req.headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    authorization: `Bearer ${o.token}`,
  }
  if (o.signal) req.signal = o.signal
  const { status, raw } = await send(req, body)
  let json
  try { json = JSON.parse(raw) } catch {
    throw new Error(`image gateway: HTTP ${status} non-JSON response: ${raw.slice(0, 200)}`)
  }
  if (!json.ok) {
    const code = json.error?.code ?? `http_${status}`
    const detail = json.error?.detail ? ` (${json.error.detail})` : ''
    throw new Error(`image gateway refused the request: ${code}${detail}`)
  }
  const images = (json.images ?? []).map((im) => ({
    data: Buffer.from(im.data, 'base64'),
    mediaType: im.media_type ?? 'image/png',
    width: im.width,
    height: im.height,
  }))
  return { text: json.text ?? '', images }
}

/** GET /healthz → engines availability. */
export async function health(o) {
  const req = requestOptions(o, 'GET', '/healthz')
  req.headers = { authorization: `Bearer ${o.token}` }
  const { raw } = await send(req)
  return JSON.parse(raw)
}
