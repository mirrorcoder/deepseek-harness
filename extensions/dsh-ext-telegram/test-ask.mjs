// Asking a human through Telegram. Run inside the dsh container:
//   node --test /data/dsh/profiles/web/node_modules/dsh-ext-telegram/test-ask.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AskDesk, ASK_PREFIX, answerNote, approvalScreen, questionScreen, tapQuestion } from './ask.js'

const place = { chatId: '42', threadId: 7 }

/** A desk whose messages land in an array instead of Telegram. */
function desk() {
  const sent = []
  const edits = []
  const instance = new AskDesk({
    post: (target, text, keyboard) => {
      sent.push({ target, text, keyboard })
      return Promise.resolve(100 + sent.length)
    },
    edit: (target, messageId, text, keyboard) => {
      edits.push({ messageId, text, keyboard })
    },
  })
  return { instance, sent, edits }
}

const tapOf = (id, action) => ({ data: `${ASK_PREFIX}${id}:${action}`, chatId: place.chatId, threadId: place.threadId })

test('an approval is two buttons, and the tap is the outcome', async () => {
  const { instance, sent, edits } = desk()
  const pending = await instance.approval(place, { toolName: 'bash', reason: 'rm -rf /tmp/x' })
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Нужно разрешение/)
  assert.match(sent[0].text, /bash/)
  assert.match(sent[0].text, /rm -rf/)
  assert.equal(sent[0].keyboard[0].length, 2)

  const answer = await instance.tap(tapOf(pending.id, 'y'))
  assert.equal(answer.answer, 'Разрешено')
  assert.equal(await pending.promise, 'allowed-once')
  // the screen it leaves behind has no buttons left to press
  assert.deepEqual(edits.at(-1).keyboard, [])
  assert.match(edits.at(-1).text, /Разрешено/)
})

test('a rejection is the other outcome, and a second tap finds nothing', async () => {
  const { instance } = desk()
  const pending = await instance.approval(place, { toolName: 'write' })
  await instance.tap(tapOf(pending.id, 'n'))
  assert.equal(await pending.promise, 'rejected')
  assert.equal((await instance.tap(tapOf(pending.id, 'y'))).answer, 'Этот вопрос уже закрыт')
})

test('an answer that arrived elsewhere closes the screen without deciding', async () => {
  const { instance, edits } = desk()
  const pending = await instance.approval(place, { toolName: 'bash' })
  instance.close(pending.id, '✔️ Решено в веб-интерфейсе')
  assert.equal(await pending.promise, undefined)
  assert.match(edits.at(-1).text, /веб-интерфейсе/)
  assert.deepEqual(edits.at(-1).keyboard, [])
})

test('a single-select question is answered by one tap', async () => {
  const { instance, sent } = desk()
  const pending = await instance.question(place, [{
    id: 'q1',
    header: 'Деплой',
    question: 'Катим на прод?',
    options: [{ label: 'Катим', description: 'Сразу' }, { label: 'Подождём' }],
  }])
  assert.match(sent[0].text, /Катим на прод/)
  assert.match(sent[0].text, /Сразу/, 'описания вариантов идут в текст, а не в подпись кнопки')
  // options, then the free-text row
  assert.equal(sent[0].keyboard.length, 3)

  await instance.tap(tapOf(pending.id, 'o0'))
  assert.deepEqual(await pending.promise, { answers: [{ id: 'q1', selected: ['Катим'] }] })
})

test('a multi-select question collects taps until Готово', async () => {
  const { instance, sent, edits } = desk()
  const pending = await instance.question(place, [{
    id: 'q1',
    question: 'Что включить?',
    multiSelect: true,
    options: [{ label: 'Логи' }, { label: 'Метрики' }, { label: 'Трейсы' }],
  }])
  assert.match(sent[0].keyboard.at(-2)[0].text, /Готово/)
  await instance.tap(tapOf(pending.id, 'o0'))
  await instance.tap(tapOf(pending.id, 'o2'))
  assert.match(edits.at(-1).keyboard[0][0].text, /☑️ Логи/)
  assert.match(edits.at(-1).keyboard[1][0].text, /⬜️ Метрики/)
  await instance.tap(tapOf(pending.id, 'o0')) // снять
  await instance.tap(tapOf(pending.id, 'done'))
  assert.deepEqual(await pending.promise, { answers: [{ id: 'q1', selected: ['Трейсы'] }] })
})

test('two questions share one message: the second replaces the first', async () => {
  const { instance, sent, edits } = desk()
  const pending = await instance.question(place, [
    { id: 'a', question: 'Первый?', options: [{ label: 'Да' }] },
    { id: 'b', question: 'Второй?', options: [{ label: 'Нет' }] },
  ])
  assert.equal(sent.length, 1)
  await instance.tap(tapOf(pending.id, 'o0'))
  assert.match(edits.at(-1).text, /Второй/)
  assert.equal(sent.length, 1, 'вторая вопрос-карточка не плодит сообщений')
  await instance.tap(tapOf(pending.id, 'o0'))
  assert.deepEqual(await pending.promise, {
    answers: [{ id: 'a', selected: ['Да'] }, { id: 'b', selected: ['Нет'] }],
  })
})

test('"своим текстом" takes the next message in that thread, once', async () => {
  const { instance } = desk()
  const pending = await instance.question(place, [{ id: 'q', question: 'Куда катим?' }])
  // ничего не ждём — обычное сообщение остаётся обычным
  assert.equal(await instance.text(place.chatId, place.threadId, 'привет'), false)
  await instance.tap(tapOf(pending.id, 'txt'))
  assert.equal(await instance.text(place.chatId, place.threadId, 'на стенд'), true)
  assert.deepEqual(await pending.promise, { answers: [{ id: 'q', selected: [], custom: 'на стенд' }] })
  assert.equal(await instance.text(place.chatId, place.threadId, 'ещё раз'), false)
})

test('a typed answer belongs to its own thread only', async () => {
  const { instance } = desk()
  const pending = await instance.question(place, [{ id: 'q', question: 'Ну?' }])
  await instance.tap(tapOf(pending.id, 'txt'))
  assert.equal(await instance.text(place.chatId, 999, 'не туда'), false)
  assert.equal(await instance.text(place.chatId, place.threadId, 'туда'), true)
})

test('the desk only claims its own buttons', () => {
  const { instance } = desk()
  assert.equal(instance.owns(`${ASK_PREFIX}1:y`), true)
  assert.equal(instance.owns('pick:session-1'), false)
  assert.equal(instance.owns(undefined), false)
})

test('a question with no questions is not asked at all', async () => {
  const { instance, sent } = desk()
  assert.equal(await instance.question(place, []), undefined)
  assert.equal(sent.length, 0)
})

test('an undeliverable message leaves nothing pending', async () => {
  const instance = new AskDesk({ post: () => Promise.resolve(undefined), edit: () => {} })
  assert.equal(await instance.approval(place, { toolName: 'bash' }), undefined)
  assert.equal(instance.pending.size, 0)
})

test('callback payloads stay inside Telegram\'s 64 bytes', async () => {
  const { instance, sent } = desk()
  await instance.question(place, [{
    id: 'a-very-long-question-identifier-that-a-caller-might-invent',
    question: 'x',
    options: [{ label: 'y'.repeat(120) }],
  }])
  for (const row of sent[0].keyboard) {
    for (const button of row) {
      assert.ok(Buffer.byteLength(button.callback_data) <= 64, button.callback_data)
      assert.ok(Buffer.byteLength(button.text) <= 128, 'подпись кнопки обрезана')
    }
  }
})

test('the pure tap reducer decides, the desk only applies', () => {
  const single = { id: 'q', options: [{ label: 'A' }, { label: 'B' }] }
  assert.deepEqual(tapQuestion(single, [], 'o1'), { kind: 'answer', item: { id: 'q', selected: ['B'] } })
  assert.deepEqual(tapQuestion(single, [], 'o9'), { kind: 'unknown' })
  assert.deepEqual(tapQuestion(single, [], 'txt'), { kind: 'text' })
  const multi = { ...single, multiSelect: true }
  assert.deepEqual(tapQuestion(multi, ['A'], 'o1'), { kind: 'toggle', selected: ['A', 'B'] })
  assert.deepEqual(tapQuestion(multi, ['A'], 'o0'), { kind: 'toggle', selected: [] })
})

test('screens escape what a tool name or a reason may contain', () => {
  const screen = approvalScreen('1', { toolName: '<b>bash</b>', reason: 'rm <all> & pray' })
  assert.ok(!screen.text.includes('<b>bash</b>'))
  assert.match(screen.text, /&lt;all&gt;/)
  const question = questionScreen('1', { question: '5 > 3?', options: [] })
  assert.match(question.text, /5 &gt; 3/)
})

test('the closing line names what was chosen', () => {
  assert.equal(answerNote([{ selected: ['A', 'B'] }, { selected: [], custom: 'своё' }]), 'A, B · своё')
  assert.equal(answerNote([]), '—')
})
