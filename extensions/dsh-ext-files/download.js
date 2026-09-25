// Which files the browser may download, and how it is told what it gets.
// Pure: testable without a server.
import { extname, sep } from 'node:path'

/** Whether a canonical path lies inside one of the canonical roots. */
export function insideAny(file, roots) {
  return roots.some((root) => file === root || file.startsWith(root.endsWith(sep) ? root : root + sep))
}

/**
 * The Content-Disposition for a download (RFC 6266 + RFC 5987). Browsers read
 * the UTF-8 `filename*`, so a Cyrillic name arrives intact; the plain
 * `filename` is only for clients that do not, and must stay ASCII.
 */
export function contentDisposition(name) {
  const ext = extname(name)
  // What is readable of the name in ASCII — or `download`, when that is too
  // little to recognise the file by ("Глава_3_…" keeps only "3").
  const kept = name.slice(0, name.length - ext.length)
    .replace(/[^\x20-\x7e]+/g, '')
    .replace(/["\\]/g, '_')
    .replace(/[_\s-]{2,}/g, '_')
    .replace(/^[_\s-]+|[_\s-]+$/g, '')
  const ascii = `${kept.replace(/[^a-z0-9]/gi, '').length >= 3 ? kept : 'download'}${/^[.a-z0-9]+$/i.test(ext) ? ext : ''}`
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

const TYPES = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json',
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
}

export function contentTypeOf(name) {
  return TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream'
}
