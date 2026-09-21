// dsh-ext-image-gen — `generate_image` tool.
//
// Images are produced by the Codex CLI's native `image_generation` tool, driven
// by the smmprop LLM gateway on the host (ChatGPT subscription session, no API
// key). The gateway returns PNG bytes; we write them into the workspace
// (<cwd>/<outputDir>/) so they show up as deliverables, and also return them as
// image blocks so the model and the chat see the picture inline.
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve, basename } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { completeWithImages } from './gateway.js'

export const name = 'ext-image-gen'
export const inject = ['tools']

export const Config = z.object({
  /** Unix socket of the gateway bridge (preferred; no network exposure). */
  socketPath: z.string().default('/run/imggw/gateway.sock'),
  /** Alternative plain-http base URL, e.g. http://172.20.0.1:18792; wins when non-empty. */
  url: z.string().default(''),
  /** Credential reference (env var name) holding the gateway bearer token. */
  tokenEnv: z.string().role('credential-ref').default('DSH_IMAGE_GATEWAY_TOKEN'),
  /** Engine on the gateway; only `codex` supports want_images. */
  engine: z.string().default('codex'),
  /** Per-call deadline forwarded to the gateway (one image is 40–90 s). */
  deadlineMs: z.number().default(280_000),
  /** Directory, relative to the workspace cwd, where PNGs are written. */
  outputDir: z.string().default('generated-images'),
  /** Upper bound on images per call (gateway caps at 4). */
  maxImages: z.number().default(4),
})

const DESCRIPTION = [
  'Generate one or more images (PNG, square ~1024px) from a text prompt using the native image model.',
  'Use it when the user asks for a picture, illustration, banner background, icon, mockup, or any visual asset.',
  'Write the prompt in English, describe subject, style, composition, lighting, palette. Avoid asking for text/letters/logos inside the image — rendered text is unreliable.',
  'The files are saved under the workspace and also shown inline. Each image takes 40–90 seconds; ask for several only when the user wants variants.',
].join(' ')

async function resolveToken(ctx, config) {
  const ref = credentialRef(config.tokenEnv)
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const got = await credentials.resolve(ref)
    if (got?.value) return got.value
  }
  const ambient = process.env[config.tokenEnv]
  if (ambient && ambient.length > 0) return ambient
  throw new Error(`image gateway credential is not configured: set ${config.tokenEnv} in the container environment`)
}

function safePrefix(s) {
  const cleaned = (s ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return cleaned.length > 0 ? cleaned : 'image'
}

export function buildPrompt(userPrompt, count) {
  return [
    `Use your image_generation tool to create ${count === 1 ? 'one image' : `${count} distinct image variants`}.`,
    `Image description: ${userPrompt}`,
    'Square format, high quality. Do not put any text, letters, digits, watermarks or logos into the image.',
    'Do not ask questions. After the image(s) are generated reply with the single word: done',
  ].join('\n')
}

export function apply(ctx, config) {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'generate_image',
    description: DESCRIPTION,
    timeoutMs: config.deadlineMs + 30_000,
    parameters: {
      prompt: { type: 'string', required: true, description: 'What to draw: subject, style, composition, lighting, colours. English. No text inside the image.' },
      count: { type: 'integer', description: 'How many variants to produce (1–4). Default 1.' },
      filename_prefix: { type: 'string', description: 'Optional short slug for the saved file names, e.g. "hero-banner".' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          files: { type: 'array', items: { type: 'string' } },
          images: { type: 'array', items: { type: 'object', additionalProperties: true } },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const blocks = []
        const lines = value.files.length === 0
          ? [`No image was produced. ${value.note ?? ''}`]
          : [`Generated ${value.files.length} image(s):`, ...value.files.map((f, i) => `- ${f} (${value.images[i]?.width ?? '?'}x${value.images[i]?.height ?? '?'})`)]
        if (value.note && value.files.length > 0) lines.push(value.note)
        blocks.push({ type: 'text', text: lines.join('\n') })
        for (const im of value.images) if (im.ref) blocks.push({ type: 'image', attachment: im.ref })
        return blocks
      },
    },
    presentCall: (args) => ({ card: 'generic', title: 'Generate image', kind: 'other', rawInput: args }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const count = Math.min(Math.max(Math.trunc(args.count ?? 1), 1), config.maxImages)
      const token = await resolveToken(ctx, config)
      const result = await completeWithImages({
        socketPath: config.socketPath,
        url: config.url,
        token,
        prompt: buildPrompt(args.prompt, count),
        engine: config.engine,
        deadlineMs: config.deadlineMs,
        signal: exec.signal,
      })
      const outDir = resolve(process.cwd(), config.outputDir)
      await mkdir(outDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
      const prefix = safePrefix(args.filename_prefix)
      const attachments = ctx.get('attachments')
      const files = []
      const images = []
      for (const [i, im] of result.images.entries()) {
        const file = join(outDir, `${stamp}-${prefix}-${i + 1}.png`)
        await writeFile(file, im.data)
        files.push(file)
        let ref
        if (attachments !== undefined) {
          try {
            ref = await attachments.saveImage({ data: new Uint8Array(im.data), mediaType: im.mediaType, name: basename(file) })
          } catch {
            ref = undefined
          }
        }
        images.push({ file, width: im.width, height: im.height, bytes: im.data.length, ...(ref ? { ref } : {}) })
      }
      let note = ''
      if (result.images.length === 0) note = `The image model returned text only: ${result.text.slice(0, 300)}`
      else if (result.images.length < count) note = `Requested ${count}, got ${result.images.length}.`
      return { files, images, note }
    },
  })))
}
