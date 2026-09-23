// dsh-ext-voice — speech into text for every surface that hears the operator.
//
//   ctx.voice.transcribe(bytes)  the service: WAV or Ogg/Opus in, text out,
//                                one transcription at a time for the whole box;
//   POST /api/voice/transcribe   the web composer's microphone (inside the
//                                harness authentication fence);
//   the microphone button        injected next to the composer's paperclip.
//
// The Telegram bridge uses the same service for voice notes, so there is one
// model, one download and one queue: two surfaces asking at once wait their
// turn instead of running two CPU-heavy transcriptions side by side.
import { join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isWav, transcribe, wavSeconds } from './whisper.js'
import { voiceRows } from './client.js'

const ROUTE = '/api/voice/transcribe'

const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })

export default class VoiceService extends Service {
  static Config = z.object({
    /** whisper.cpp model; fetched once into $DSH_HOME/models on first use. */
    model: z.string().default('small-q5_1'),
    /** Spoken language, or `auto`. Pinning it is faster and more accurate. */
    language: z.string().default('ru'),
    threads: z.number().default(3),
    /** Longest recording accepted from the page, in seconds. */
    maxSeconds: z.number().default(300),
    /** Show the microphone in the web composer. */
    button: z.boolean().default(true),
  })

  constructor(ctx, config = {}) {
    super(ctx, 'voice')
    // No #private fields: consumers reach a Service through a Proxy, and a
    // private-field read through it throws.
    this._config = config
    this._queue = Promise.resolve()

    ctx.inject(['connection'], (cctx) => {
      cctx.effect(() => cctx.connection.fetch.register({
        path: ROUTE,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request) => this._handle(request),
      }), 'ext-voice: route')
    })

    if (config.button !== false) {
      const rows = voiceRows()
      ctx.inject(['webServer'], (wctx) => {
        wctx.on('webserver/index-inject', (table) => {
          for (const row of rows) table.push(row)
        })
      })
    }
  }

  /**
   * Speech to text. Serialised across every caller on this box.
   * @param {Buffer|Uint8Array} audio - WAV (web) or Ogg/Opus (Telegram).
   * @param {{language?: string}} [options]
   * @returns {Promise<string>} the transcript; empty when nothing was said.
   */
  transcribe(audio, options = {}) {
    const job = this._queue.then(() => transcribe(Buffer.from(audio), {
      modelDir: join(process.env.DSH_HOME ?? '/data/dsh', 'models'),
      model: this._config.model ?? 'small-q5_1',
      language: options.language || this._config.language || 'ru',
      threads: this._config.threads ?? 3,
    }))
    this._queue = job.catch(() => {})
    return job
  }

  async _handle(request) {
    let bytes
    try {
      bytes = Buffer.from(await request.arrayBuffer())
    } catch {
      return json({ ok: false, error: 'не смог прочитать запись' }, 400)
    }
    if (!isWav(bytes)) return json({ ok: false, error: 'ожидаю WAV — страница перекодирует запись сама' }, 415)
    const seconds = wavSeconds(bytes) ?? 0
    const max = this._config.maxSeconds ?? 300
    if (seconds > max) return json({ ok: false, error: `запись длиннее ${Math.round(max / 60)} мин` }, 413)
    // ?lang=en|ru|auto overrides the configured language for one recording.
    const lang = new URL(request.url, 'http://local').searchParams.get('lang') ?? undefined
    const started = Date.now()
    try {
      const text = await this.transcribe(bytes, { language: /^[a-z]{2,4}$/.test(lang ?? '') ? lang : undefined })
      return json({ ok: true, text, seconds: Math.round(seconds), tookMs: Date.now() - started })
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  }
}
