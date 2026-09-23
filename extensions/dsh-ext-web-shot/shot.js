// Headless Chromium driven over the DevTools protocol: open, wait, capture.
//
// The first version used Chromium's own `--screenshot` flag with a virtual-time
// budget. That hangs forever on any page that keeps a connection open — SSE,
// a websocket, a long poll — because virtual time only advances when the
// network is idle, and on such a page it never is. The harness's own UI is one
// of those pages, and so are most apps worth checking. So the browser is now
// told what to do step by step: navigate, wait for the load event (capped),
// wait the requested real time for the page's scripts, then capture. Node 22's
// built-in WebSocket speaks to it; no Playwright, no dependency.
//
// Pure where it can be: argument building, URL checks and text trimming are
// testable without a browser.
import { spawn } from 'node:child_process'

/** Only web addresses: a file:// or chrome:// URL would read the container, not the web. */
export function checkUrl(raw) {
  let url
  try {
    url = new URL(String(raw ?? '').trim())
  } catch {
    throw new Error(`not a URL: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`only http and https pages can be opened, not ${url.protocol}`)
  }
  return url.toString()
}

export function clamp(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.round(n), min), max)
}

/** The browser's own command line: headless, no GPU, a throwaway profile, a DevTools port. */
export function launchArgs(profileDir) {
  return [
    '--headless=new',
    // The container runs as root, and Chromium refuses its own sandbox as root.
    // The page is still confined by the container itself.
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--disable-extensions',
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    'about:blank',
  ]
}

/** The browser-level DevTools socket, from the line Chromium prints on start. */
export function devtoolsUrl(stderrText) {
  return /DevTools listening on (ws:\/\/\S+)/.exec(String(stderrText ?? ''))?.[1]
}

/** Visible text, whitespace tidied and capped, saying when it was cut. */
export function tidyText(text, maxChars = 12_000) {
  const body = String(text ?? '')
    .replace(/[ \t\f\v]+/g, ' ')
    // trim each line but keep blank lines: innerText marks paragraphs with them
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return body.length > maxChars ? `${body.slice(0, maxChars)}\n…(обрезано, всего ${body.length} символов)` : body
}

/** A file-name slug for a URL: host plus path, safe characters only. */
export function slugOf(url) {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}${parsed.pathname}`.replace(/[^a-zA-Z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'page'
  } catch {
    return 'page'
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Open a page and capture it.
 * @param {string} url
 * @param {{binary: string, profileDir: string, mode: 'screenshot'|'text',
 *          width?: number, height?: number, waitMs?: number, timeoutMs?: number}} options
 * @returns {Promise<{status?: number, title: string, png?: Buffer, text?: string}>}
 */
export async function capture(url, options) {
  const timeoutMs = options.timeoutMs ?? 45_000
  const width = clamp(options.width, 320, 2560, 1280)
  const height = clamp(options.height, 240, 4000, 800)
  const waitMs = clamp(options.waitMs, 0, 20_000, 3_000)
  const child = spawn(options.binary, launchArgs(options.profileDir), { stdio: ['ignore', 'ignore', 'pipe'] })
  let socket
  let timedOut = false
  const deadline = setTimeout(() => {
    timedOut = true
    try { socket?.close() } catch { /* already closed */ }
    child.kill('SIGKILL')
  }, timeoutMs)
  try {
    // 1. where the browser listens
    const endpoint = await new Promise((resolve, reject) => {
      let seen = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        seen += chunk
        const found = devtoolsUrl(seen)
        if (found !== undefined) resolve(found)
      })
      child.on('error', (error) => reject(error.code === 'ENOENT' ? new Error(`${options.binary} is not installed in this image`) : error))
      child.on('exit', (code) => reject(new Error(`chromium exited with ${code} before it was ready: ${seen.trim().split('\n').slice(-2).join(' ')}`)))
    })

    // 2. one socket, flattened sessions: commands carry the page's sessionId
    socket = new WebSocket(endpoint)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', () => reject(new Error('could not reach the browser over DevTools')), { once: true })
    })
    let next = 0
    const pending = new Map()
    const waiters = []
    // A command still waiting when the browser goes away must fail, not hang:
    // this is where the overall deadline turns into an error the agent can read.
    socket.addEventListener('close', () => {
      const reason = timedOut
        ? new Error(`the page did not finish in ${Math.round(timeoutMs / 1000)} s`)
        : new Error('the browser closed the DevTools connection')
      for (const { reject } of pending.values()) reject(reason)
      pending.clear()
    })
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id)
        pending.delete(message.id)
        if (message.error) reject(new Error(message.error.message))
        else resolve(message.result)
        return
      }
      for (const waiter of [...waiters]) {
        if (waiter.method === message.method && waiter.test(message.params ?? {})) {
          waiters.splice(waiters.indexOf(waiter), 1)
          waiter.resolve(message.params ?? {})
        }
      }
    })
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++next
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
    const eventOf = (method, test = () => true) => new Promise((resolve) => { waiters.push({ method, test, resolve }) })

    const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
    await send('Page.enable', {}, sessionId)
    await send('Network.enable', {}, sessionId)
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 }, sessionId)

    // 3. navigate; the main document's status says whether the page even opened
    let status
    const documentResponse = eventOf('Network.responseReceived', (p) => p.type === 'Document')
      .then((p) => { status = p.response?.status })
    const loaded = eventOf('Page.loadEventFired')
    const navigation = await send('Page.navigate', { url }, sessionId)
    if (navigation?.errorText) throw new Error(`the page did not open: ${navigation.errorText}`)
    // The load event, capped: a page that never finishes loading is still worth
    // a picture of whatever it managed to render.
    await Promise.race([loaded, sleep(Math.min(20_000, timeoutMs / 2))])
    await Promise.race([documentResponse, sleep(100)])
    // 4. real time for the page's own scripts, whatever its connections do
    await sleep(waitMs)

    const { result } = await send('Runtime.evaluate', {
      expression: 'JSON.stringify({ title: document.title, text: document.body ? document.body.innerText : "" })',
      returnByValue: true,
    }, sessionId)
    const page = JSON.parse(result?.value ?? '{"title":"","text":""}')
    if (options.mode === 'text') return { status, title: page.title, text: page.text }
    const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
    return { status, title: page.title, png: Buffer.from(shot.data, 'base64') }
  } finally {
    clearTimeout(deadline)
    try { socket?.close() } catch { /* already closed */ }
    // Wait until the browser is really gone: a killed Chromium keeps writing to
    // its profile for a moment, and a caller that removes the profile directory
    // right away races it — the directory survives and /tmp slowly fills.
    if (child.exitCode === null && child.signalCode === null) {
      const gone = new Promise((resolve) => child.once('exit', resolve))
      child.kill('SIGKILL')
      await Promise.race([gone, sleep(3_000)])
    }
  }
}
