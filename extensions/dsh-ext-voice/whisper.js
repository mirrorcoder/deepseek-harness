// Speech into text, on this machine.
//
// whisper.cpp wants 16 kHz WAV. Two kinds of input arrive: a Telegram voice
// note is Ogg/Opus, which `opusdec` from opus-tools converts without dragging
// in the whole of ffmpeg; the web composer's microphone sends WAV already,
// because the browser does the resampling (see client.js) — so that path needs
// no converter at all. The model is not baked into the image: it is fetched
// into $DSH_HOME/models on first use and kept across updates, so the image
// stays small and a deployment that never hears a voice never pays for it.
//
// Everything that touches the filesystem, the network or a subprocess is
// injected, so the pipeline is testable without any of them.
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

/** Run one command and collect what it printed; rejects on a non-zero exit or the deadline. */
export function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 180_000
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${command} did not finish in ${Math.round(timeoutMs / 1000)} s`))
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${command} exited with ${code}: ${stderr.trim().split('\n').slice(-3).join(' ')}`))
    })
  })
}

/** Whisper's plain-text output, without the blank-audio markers it prints for silence. */
export function cleanTranscript(text) {
  return String(text ?? '')
    .replace(/\[(BLANK_AUDIO|MUSIC|NOISE|SOUND)[^\]]*\]/gi, '')
    .replace(/\([^)]*(музыка|music)[^)]*\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Make sure the model file exists, downloading it once.
 * Written to a temporary name and renamed into place, so an interrupted
 * download never leaves a truncated model that whisper would then load.
 */
export async function ensureModel(dir, model, deps = {}) {
  const path = join(dir, `ggml-${model}.bin`)
  const exists = deps.exists ?? (async (p) => (await stat(p).catch(() => undefined))?.size > 1_000_000)
  if (await exists(path)) return path
  await mkdir(dir, { recursive: true })
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const response = await fetchImpl(`${MODEL_BASE_URL}/ggml-${model}.bin`)
  if (!response.ok || response.body === null) throw new Error(`model download failed: HTTP ${response.status}`)
  const partial = `${path}.part`
  const out = createWriteStream(partial)
  for await (const chunk of response.body) out.write(chunk)
  await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())))
  await rename(partial, path)
  return path
}

/** RIFF/WAVE, the only container whisper reads without a converter. */
export function isWav(bytes) {
  const b = Buffer.from(bytes ?? [])
  return b.length > 44 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE'
}

/** Seconds of audio in a PCM WAV, from its header; undefined when unreadable. */
export function wavSeconds(bytes) {
  const b = Buffer.from(bytes ?? [])
  if (!isWav(b)) return undefined
  const byteRate = b.readUInt32LE(28)
  return byteRate > 0 ? (b.length - 44) / byteRate : undefined
}

/**
 * Speech to text.
 * @param {Buffer} audio - Ogg/Opus (a Telegram voice note) or WAV (the web microphone).
 * @param {{modelDir: string, model: string, language: string, threads: number,
 *          whisper?: string, opusdec?: string, run?: Function}} options
 */
export async function transcribe(audio, options) {
  const runner = options.run ?? run
  const work = join(tmpdir(), `dsh-voice-${randomUUID()}`)
  await mkdir(work, { recursive: true })
  try {
    const wav = join(work, 'in.wav')
    if (isWav(audio)) {
      await writeFile(wav, audio)
    } else {
      const ogg = join(work, 'in.ogg')
      await writeFile(ogg, audio)
      await runner(options.opusdec ?? 'opusdec', ['--quiet', '--rate', '16000', ogg, wav], { timeoutMs: 60_000 })
    }
    const model = await ensureModel(options.modelDir, options.model, options.modelDeps)
    const { stdout } = await runner(options.whisper ?? 'whisper-cli', [
      '-m', model,
      '-f', wav,
      '-l', options.language || 'auto',
      '-t', String(options.threads || 4),
      '-nt',
      '-np',
    ], { timeoutMs: options.timeoutMs ?? 240_000 })
    return cleanTranscript(stdout)
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}
