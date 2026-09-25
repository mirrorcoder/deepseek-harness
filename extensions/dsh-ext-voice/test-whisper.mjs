// Speech into text. Run inside the dsh container:
//   node --test /data/dsh/profiles/web/node_modules/dsh-ext-voice/test-whisper.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { audioContextFor, cleanTranscript, ensureModel, isWav, transcribe, wavSeconds } from './whisper.js'

test('silence markers are not words', () => {
  assert.equal(cleanTranscript(' [BLANK_AUDIO] '), '')
  assert.equal(cleanTranscript('Привет, [MUSIC] сделай   отчёт.'), 'Привет, сделай отчёт.')
})

test('the pipeline converts, transcribes and cleans, with the language pinned', async () => {
  const calls = []
  const text = await transcribe(Buffer.from('ogg'), {
    modelDir: '/tmp/models',
    model: 'small-q5_1',
    language: 'ru',
    threads: 2,
    modelDeps: { exists: async () => true },
    run: async (command, args) => {
      calls.push([command, args])
      return { stdout: command === 'whisper-cli' ? ' Сделай бэкап базы.\n' : '' }
    },
  })
  assert.equal(text, 'Сделай бэкап базы.')
  assert.equal(calls[0][0], 'opusdec')
  assert.ok(calls[0][1].includes('16000'), 'whisper читает только 16 кГц')
  assert.equal(calls[1][0], 'whisper-cli')
  assert.deepEqual(calls[1][1].slice(calls[1][1].indexOf('-l'), calls[1][1].indexOf('-l') + 2), ['-l', 'ru'])
  assert.ok(calls[1][1].includes('/tmp/models/ggml-small-q5_1.bin'))
})

test('a model already on disk is not downloaded again', async () => {
  let fetched = false
  const path = await ensureModel('/tmp/models', 'small-q5_1', {
    exists: async () => true,
    fetch: async () => { fetched = true },
  })
  assert.equal(path, '/tmp/models/ggml-small-q5_1.bin')
  assert.equal(fetched, false)
})

test('a failed download says so instead of leaving a broken model', async () => {
  await assert.rejects(ensureModel('/tmp/models-x', 'nope', {
    exists: async () => false,
    fetch: async () => ({ ok: false, status: 404, body: null }),
  }), /HTTP 404/)
})

/** A minimal PCM WAV: 16 kHz, mono, 16-bit, `seconds` of silence. */
function wav(seconds = 1) {
  const samples = Math.round(16000 * seconds)
  const b = Buffer.alloc(44 + samples * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples * 2, 4); b.write('WAVE', 8)
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34)
  b.write('data', 36); b.writeUInt32LE(samples * 2, 40)
  return b
}

test('a WAV from the browser skips the converter entirely', async () => {
  const calls = []
  const text = await transcribe(wav(2), {
    modelDir: '/tmp/models', model: 'small-q5_1', language: 'ru', threads: 2,
    modelDeps: { exists: async () => true },
    run: async (command) => {
      calls.push(command)
      return { stdout: command === 'whisper-cli' ? 'Проверка микрофона.' : '' }
    },
  })
  assert.equal(text, 'Проверка микрофона.')
  assert.deepEqual(calls, ['whisper-cli'], 'opusdec не нужен, браузер уже прислал 16 кГц WAV')
})

test('the header says what the bytes are and how long they last', () => {
  assert.equal(isWav(wav(1)), true)
  assert.equal(isWav(Buffer.from('OggS....')), false)
  assert.equal(isWav(undefined), false)
  assert.equal(Math.round(wavSeconds(wav(3))), 3)
  assert.equal(wavSeconds(Buffer.from('not audio')), undefined)
})

test('a short phrase is encoded in a 15 s window, a long one in the full 30 s', () => {
  assert.equal(audioContextFor(4.5), 768)
  assert.equal(audioContextFor(13), 768)
  assert.equal(audioContextFor(13.5), 0, 'a 768-frame window holds 15.4 s: no margin left past 13 s')
  assert.equal(audioContextFor(undefined), 0, 'unknown length: the full window, never a guess')
  assert.equal(audioContextFor(0), 0)
})

/** The arguments whisper-cli receives for `audio` under `options`. */
async function whisperArgs(audio, options = {}) {
  let seen
  await transcribe(audio, {
    modelDir: '/tmp/models', model: 'small-q5_1', language: 'ru', threads: 4, ...options,
    modelDeps: { exists: async () => true },
    run: async (command, args) => {
      if (command === 'whisper-cli') seen = args
      return { stdout: 'текст' }
    },
  })
  return seen
}
const pair = (args, flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)

test('dictation is decoded fast: all threads, greedy, no fallback, a short window', async () => {
  const args = await whisperArgs(wav(5))
  assert.equal(pair(args, '-t'), '4')
  assert.equal(pair(args, '-bs'), '1')
  assert.equal(pair(args, '-bo'), '1')
  assert.ok(args.includes('-nf'), 'temperature fallback doubled the time on hard phrases')
  assert.equal(pair(args, '-ac'), '768')
  assert.equal(pair(await whisperArgs(wav(20)), '-ac'), undefined, 'a long recording keeps the full window')
})

test('each speed-up can be switched back off', async () => {
  const args = await whisperArgs(wav(5), { beamSize: 5, fallback: true, shortContext: false })
  assert.equal(pair(args, '-bs'), '5')
  assert.ok(!args.includes('-nf'))
  assert.ok(!args.includes('-ac'))
})
