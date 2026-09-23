// Headless Chromium from the command line: one process per call, no driver.
//
// Chromium can screenshot a page and dump its rendered DOM by itself, which is
// all an agent needs to check that something it deployed actually opens and
// says what it should. No Playwright, no browser service, no network hop to
// someone else's screenshot API: anyone who builds this repository gets the
// same tool.
//
// Pure where it can be: argument building, URL checks and HTML-to-text are
// testable without a browser; the one subprocess is injected.
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

function clamp(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.round(n), min), max)
}

/** The shared flags: headless, no GPU, a throwaway profile, and time for scripts to run. */
export function baseArgs(options) {
  const waitMs = clamp(options.waitMs, 0, 20_000, 3_000)
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
    `--user-data-dir=${options.profileDir}`,
    // Lets the page's own scripts run before the capture, so a client-rendered
    // app is photographed after it rendered rather than as a blank shell.
    `--virtual-time-budget=${waitMs}`,
  ]
}

export function screenshotArgs(url, options) {
  const width = clamp(options.width, 320, 2560, 1280)
  const height = clamp(options.height, 240, 4000, 800)
  return [...baseArgs(options), `--window-size=${width},${height}`, `--screenshot=${options.out}`, url]
}

export function domArgs(url, options) {
  return [...baseArgs(options), '--dump-dom', url]
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/**
 * What a reader of the page would see: title plus visible text, scripts and
 * styles removed, whitespace collapsed. Not a DOM parser — a page's words are
 * what an agent checks, and a regex pass over a dumped DOM gets those right.
 */
export function htmlToText(html, maxChars = 12_000) {
  const source = String(html ?? '')
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(source)?.[1] ?? '').trim()
  const body = source
    .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, code) => {
      if (code[0] === '#') {
        const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
        return Number.isFinite(n) ? String.fromCodePoint(n) : match
      }
      return ENTITIES[code.toLowerCase()] ?? match
    })
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const text = body.length > maxChars ? `${body.slice(0, maxChars)}\n…(обрезано, всего ${body.length} символов)` : body
  return { title, text }
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

/** Run Chromium once; resolves stdout, rejects with the tail of stderr. */
export function runChromium(binary, args, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { if (stdout.length < 20_000_000) stdout += chunk })
    child.stderr.on('data', (chunk) => { if (stderr.length < 200_000) stderr += chunk })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`the page did not finish in ${Math.round(timeoutMs / 1000)} s`))
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error.code === 'ENOENT' ? new Error(`${binary} is not installed in this image`) : error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new Error(`chromium exited with ${code}: ${stderr.trim().split('\n').slice(-2).join(' ')}`))
    })
  })
}
