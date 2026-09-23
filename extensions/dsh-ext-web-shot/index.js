// dsh-ext-web-shot — look at a web page the way a person would.
//
//   screenshot — a PNG of the page, shown inline and kept under
//                /workspace/screenshots/<project>, never inside the project;
//   page_text  — the page's title and visible text, after its scripts ran.
//
// For checking that something just deployed actually opens, renders and says
// what it should — without asking the operator to go and look. Headless
// Chromium runs inside this container (see shot.js); nothing leaves the box
// except the request to the page itself.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { capture, checkUrl, slugOf, tidyText } from './shot.js'

export const name = 'ext-web-shot'
export const inject = ['tools']

export const Config = z.object({
  chromium: z.string().default('chromium'),
  timeoutSeconds: z.number().default(45),
  /**
   * Where pictures go. Deliberately the harness's own workspace, NOT the
   * session's project: a session can run inside a real repository, and a
   * screenshot dropped there is an untracked directory in someone's git tree —
   * the first live run left one in the operator's main project. One folder
   * per project keeps them apart.
   */
  outputDir: z.string().default('/workspace/screenshots'),
  maxTextChars: z.number().default(12_000),
})

export function apply(ctx, config) {
  const cwdOf = (exec) => exec?.agent?.session?.header?.cwd ?? exec?.agent?.session?.cwd ?? process.cwd()

  /** A throwaway browser profile per call, so two calls never fight over one. */
  const withProfile = async (work) => {
    const profileDir = await mkdtemp(join(tmpdir(), 'dsh-chromium-'))
    try {
      return await work(profileDir)
    } finally {
      await rm(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
    }
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'screenshot',
    description: [
      'Open a web page in a headless browser and take a PNG screenshot of it.',
      'Use it to check that a page you deployed or changed really opens and looks right, instead of asking the user to look.',
      'The picture is shown inline and kept in the harness workspace, never inside the project. Only http(s) URLs.',
    ].join(' '),
    parameters: {
      url: { type: 'string', required: true, description: 'The page to open, http:// or https://.' },
      width: { type: 'integer', description: 'Viewport width in pixels, 320–2560; default 1280. Use 390 for a phone.' },
      height: { type: 'integer', description: 'Viewport height in pixels, 240–4000; default 800. A tall value captures more of a long page.' },
      wait_ms: { type: 'integer', description: 'How long the page may run its scripts before the capture, 0–20000; default 3000.' },
    },
    timeoutMs: (config.timeoutSeconds + 15) * 1000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { file: { type: 'string' }, url: { type: 'string' }, image: { type: 'object', additionalProperties: true } },
      },
      render: (_args, value) => [
        { type: 'text', text: `Скриншот ${value.url}${value.status ? ` (HTTP ${value.status})` : ''}${value.title ? ` «${value.title}»` : ''} → ${value.file}` },
        ...(value.image?.ref ? [{ type: 'image', attachment: value.image.ref }] : []),
      ],
    },
    presentCall: (args) => ({ card: 'generic', title: `Скриншот: ${args.url}`, kind: 'other', rawInput: args }),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const url = checkUrl(args.url)
      const project = (cwdOf(exec).split('/').filter(Boolean).pop() ?? 'workspace').replace(/[^a-zA-Z0-9._-]+/g, '-')
      const outDir = config.outputDir.startsWith('/')
        ? join(config.outputDir, project)
        : join(cwdOf(exec), config.outputDir)
      await mkdir(outDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
      const file = join(outDir, `${stamp}-${slugOf(url)}.png`)
      const shot = await withProfile((profileDir) => capture(url, {
        binary: config.chromium,
        profileDir,
        mode: 'screenshot',
        width: args.width,
        height: args.height,
        waitMs: args.wait_ms,
        timeoutMs: config.timeoutSeconds * 1000,
      }))
      const data = shot.png
      await writeFile(file, data)
      let ref
      const attachments = ctx.get('attachments')
      if (attachments !== undefined) {
        try {
          ref = await attachments.saveImage({ data: new Uint8Array(data), mediaType: 'image/png', name: basename(file) })
        } catch {
          ref = undefined
        }
      }
      return { file, url, status: shot.status, title: shot.title, image: { bytes: data.length, ...(ref ? { ref } : {}) } }
    },
  })), 'ext-web-shot: screenshot')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'page_text',
    description: [
      'Open a web page in a headless browser, let its scripts run, and return its title and visible text.',
      'Use it to check what a page actually says after rendering — an error message, a price, a deployed version string — where fetching the raw HTML would only show an empty app shell.',
    ].join(' '),
    parameters: {
      url: { type: 'string', required: true, description: 'The page to open, http:// or https://.' },
      wait_ms: { type: 'integer', description: 'How long the page may run its scripts first, 0–20000; default 3000.' },
    },
    timeoutMs: (config.timeoutSeconds + 15) * 1000,
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { title: { type: 'string' }, text: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: `${value.status ? `HTTP ${value.status}\n` : ''}${value.title ? `# ${value.title}\n\n` : ''}${value.text || '(на странице нет видимого текста)'}` }],
    },
    presentCall: (args) => ({ card: 'generic', title: `Текст страницы: ${args.url}`, kind: 'other', rawInput: args }),
    isConcurrencySafe: () => true,
    async execute(args) {
      const url = checkUrl(args.url)
      const page = await withProfile((profileDir) => capture(url, {
        binary: config.chromium,
        profileDir,
        mode: 'text',
        waitMs: args.wait_ms,
        timeoutMs: config.timeoutSeconds * 1000,
      }))
      return { url, status: page.status, title: page.title, text: tidyText(page.text, config.maxTextChars) }
    },
  })), 'ext-web-shot: page_text')
}
