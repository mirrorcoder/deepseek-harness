// dsh-ext-files — download what the agent made, from the browser.
//
// Upstream's deliverable cards can only open a file on the Host's own desktop,
// and a harness in a container has none: "This Host has no desktop available
// to open files or folders". So:
//
//   GET /api/files/download?path=<absolute path>
//       inside the harness authentication fence; one regular file from a
//       registered workspace (or `roots`), streamed, under its real name;
//   a Download button on every deliverable card, next to Open.
//
// Paths are resolved to their real location before the check, so neither `..`
// nor a symlink inside a workspace reaches a file outside it.
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { Readable } from 'node:stream'
import z from '@deepseek-ai/schemastery'
import { contentDisposition, contentTypeOf, insideAny } from './download.js'
import { filesRows } from './client.js'

export const name = 'ext-files'

const ROUTE = '/api/files/download'

export const Config = z.object({
  /** Directories files may come from, besides every registered workspace. */
  roots: z.array(z.string()).default(['/workspace']),
  /** Show the Download button on deliverable cards. */
  button: z.boolean().default(true),
})

const text = (status, message) => new Response(message, {
  status,
  headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
})

/**
 * Serve one file for download.
 * @param {Request} request - GET or HEAD with `?path=`.
 * @param {string[]} roots - directories files may come from; resolved here.
 * @returns {Promise<Response>}
 */
export async function serveDownload(request, roots) {
  const raw = new URL(request.url, 'http://local').searchParams.get('path') ?? ''
  if (!raw.startsWith('/')) return text(400, 'нужен абсолютный путь к файлу')
  let file
  try {
    file = await realpath(raw)
  } catch {
    return text(404, 'такого файла нет')
  }
  const allowed = (await Promise.all(roots.map((root) => realpath(root).catch(() => undefined)))).filter(Boolean)
  if (!insideAny(file, allowed)) return text(403, 'файл вне воркспейсов — его отсюда не отдать')
  const info = await stat(file).catch(() => undefined)
  if (info === undefined || !info.isFile()) return text(400, 'это не файл')
  const shownName = basename(raw) // the name the operator saw, even when it is a link
  const headers = {
    'content-type': contentTypeOf(shownName),
    'content-length': String(info.size),
    'content-disposition': contentDisposition(shownName),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
  return new Response(Readable.toWeb(createReadStream(file)), { status: 200, headers })
}

export function apply(ctx, config = {}) {
  const roots = () => [
    ...(config.roots ?? ['/workspace']),
    ...(ctx.get('workspaceRegistry')?.list().map((workspace) => workspace.path) ?? []),
  ]

  ctx.inject(['connection'], (cctx) => {
    cctx.effect(() => cctx.connection.fetch.register({
      path: ROUTE,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: (request) => serveDownload(request, roots()),
    }), 'ext-files: route')
  })

  if (config.button !== false) {
    const rows = filesRows()
    ctx.inject(['webServer'], (wctx) => {
      wctx.on('webserver/index-inject', (table) => {
        for (const row of rows) table.push(row)
      })
    })
  }
}
