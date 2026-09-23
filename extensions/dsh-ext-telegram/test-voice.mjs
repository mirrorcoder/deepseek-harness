// Voice notes into text. Run inside the dsh container:
//   node --test /data/dsh/profiles/web/node_modules/dsh-ext-telegram/test-voice.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanTranscript, ensureModel, transcribe } from './voice.js'

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
