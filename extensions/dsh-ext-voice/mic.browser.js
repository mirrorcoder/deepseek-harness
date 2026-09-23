// Dictation for the harness composer. Injected into the page by dsh-ext-voice.
//
// A microphone button appears next to the paperclip. Click to record, click
// again to stop, Esc to cancel. The recording is decoded by the browser and
// resampled to 16 kHz mono WAV right here — Chrome records WebM, Safari MP4,
// Firefox Ogg, and whisper reads none of them, but every browser can decode
// what it recorded — so the server needs no converter. The text is inserted
// into the composer, not sent: dictation makes mistakes, and the operator
// gets to fix them before anything reaches the agent.
;(() => {
  if (window.__dshVoice) return
  window.__dshVoice = true

  const ROUTE = '/api/voice/transcribe'
  const MAX_SECONDS = 180
  const RATE = 16000

  let recorder = null
  let stream = null
  let chunks = []
  let startedAt = 0
  let ticker = null
  let cancelled = false
  let state = 'idle' // idle | recording | busy

  // ── the pill: what is happening, above the composer ───────────────────────
  const pill = document.createElement('div')
  pill.className = 'dsh-mic-pill'
  document.body.appendChild(pill)
  let pillTimer = null
  const show = (text, kind) => {
    clearTimeout(pillTimer)
    pill.textContent = text
    pill.dataset.kind = kind || ''
    pill.dataset.open = '1'
    if (kind === 'err' || kind === 'ok') pillTimer = setTimeout(() => { pill.dataset.open = '' }, 4000)
  }
  const hide = () => { pill.dataset.open = '' }

  // ── the composer ──────────────────────────────────────────────────────────
  // Anchored on the composer's hidden file input: it sits right after the
  // paperclip in the upstream markup, and unlike class names (hashed CSS
  // modules) or labels (localised) it does not change between builds.
  const composer = () => {
    const input = document.querySelector('input[type="file"][multiple]')
    if (!input) return null
    let root = input.parentElement
    while (root && !root.querySelector('[contenteditable]')) root = root.parentElement
    if (!root) return null
    const editor = root.querySelector('[contenteditable="true"]') || root.querySelector('[contenteditable]')
    const attach = input.previousElementSibling
    return editor ? { input, editor, attach } : null
  }

  const MIC = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" stroke="currentColor" stroke-width="1.3"/>' +
    '<path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'

  const place = () => {
    const c = composer()
    if (!c) return
    const parent = c.input.parentElement
    if (parent.querySelector(':scope > .dsh-mic')) return
    const button = document.createElement('button')
    button.type = 'button'
    // borrow the paperclip's own classes so the button looks native
    const twin = c.attach && c.attach.tagName === 'BUTTON' ? c.attach : c.attach && c.attach.querySelector('button')
    button.className = 'dsh-mic ' + (twin ? twin.className : '')
    button.title = 'Надиктовать (Esc — отменить)'
    button.setAttribute('aria-label', 'Надиктовать')
    button.innerHTML = MIC
    button.addEventListener('mousedown', (event) => event.preventDefault()) // keep the editor's focus
    button.addEventListener('click', toggle)
    parent.insertBefore(button, c.input)
    paint()
  }

  const paint = () => {
    for (const button of document.querySelectorAll('.dsh-mic')) {
      button.dataset.state = state
      button.disabled = state === 'busy'
    }
  }

  // ── recording ─────────────────────────────────────────────────────────────
  const toggle = () => {
    if (state === 'recording') stop()
    else if (state === 'idle') start()
  }

  const clock = () => {
    const s = Math.floor((Date.now() - startedAt) / 1000)
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
  }

  const start = async () => {
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      show('Этот браузер не умеет записывать звук', 'err')
      return
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (error) {
      show(error && error.name === 'NotAllowedError'
        ? 'Нет доступа к микрофону — разреши его для этого сайта'
        : 'Микрофон недоступен: ' + ((error && error.message) || error), 'err')
      return
    }
    chunks = []
    cancelled = false
    recorder = new MediaRecorder(stream)
    recorder.ondataavailable = (event) => { if (event.data && event.data.size > 0) chunks.push(event.data) }
    recorder.onstop = finish
    recorder.start()
    startedAt = Date.now()
    state = 'recording'
    paint()
    show('● ' + clock() + ' · нажми микрофон ещё раз, чтобы закончить · Esc — отмена', 'rec')
    ticker = setInterval(() => {
      if ((Date.now() - startedAt) / 1000 >= MAX_SECONDS) { stop(); return }
      show('● ' + clock() + ' · нажми микрофон ещё раз, чтобы закончить · Esc — отмена', 'rec')
    }, 250)
  }

  const stop = () => {
    clearInterval(ticker)
    if (recorder && recorder.state !== 'inactive') recorder.stop()
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state === 'recording') {
      cancelled = true
      stop()
    }
  }, true)

  const release = () => {
    if (stream) for (const track of stream.getTracks()) track.stop()
    stream = null
  }

  const finish = async () => {
    release()
    if (cancelled) {
      state = 'idle'
      paint()
      show('Запись отменена', 'ok')
      return
    }
    state = 'busy'
    paint()
    show('Расшифровываю…', 'busy')
    try {
      const recorded = new Blob(chunks, { type: (recorder && recorder.mimeType) || 'audio/webm' })
      const wav = await toWav(recorded)
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: wav,
        credentials: 'same-origin',
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body.ok === false) throw new Error(body.error || ('HTTP ' + response.status))
      const text = String(body.text || '').trim()
      if (text.length === 0) {
        show('Не расслышал ни слова', 'err')
      } else {
        // hide first: a failed insertion reports itself in the same pill
        hide()
        await insert(text)
      }
    } catch (error) {
      show('Не получилось: ' + ((error && error.message) || error), 'err')
    } finally {
      state = 'idle'
      paint()
    }
  }

  // ── any recording → 16 kHz mono PCM WAV ───────────────────────────────────
  const toWav = async (blob) => {
    const AudioCtx = window.AudioContext || window.webkitAudioContext
    const live = new AudioCtx()
    let decoded
    try {
      decoded = await live.decodeAudioData(await blob.arrayBuffer())
    } finally {
      live.close()
    }
    const frames = Math.max(1, Math.ceil(decoded.duration * RATE))
    // One output channel: the offline render mixes stereo down on its own.
    const offline = new OfflineAudioContext(1, frames, RATE)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start()
    const pcm = (await offline.startRendering()).getChannelData(0)
    const out = new ArrayBuffer(44 + pcm.length * 2)
    const view = new DataView(out)
    const text = (offset, s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)) }
    text(0, 'RIFF'); view.setUint32(4, 36 + pcm.length * 2, true); text(8, 'WAVE')
    text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
    view.setUint32(24, RATE, true); view.setUint32(28, RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
    text(36, 'data'); view.setUint32(40, pcm.length * 2, true)
    for (let i = 0; i < pcm.length; i++) {
      const v = Math.max(-1, Math.min(1, pcm[i]))
      view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true)
    }
    return new Blob([out], { type: 'audio/wav' })
  }

  // ── into the editor, where the caret is ───────────────────────────────────
  // The composer is a Lexical editor: its state is Lexical's, not the DOM's,
  // so text goes in through the editing events it listens to rather than by
  // writing to the element. And Lexical renders on its OWN tick: right after
  // the insert the DOM still shows the old text. The first version checked
  // synchronously, concluded the insert had failed, inserted a second time by
  // the fallback and reported an error — "Слышишь?Слышишь?" plus a red pill.
  // So the result is judged only after the editor has rendered, and the
  // fallback runs only when the first way really did nothing.
  const settle = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 30)))

  const insert = async (text) => {
    const c = composer()
    if (!c) { show('Не нашёл поле ввода — текст: ' + text, 'err'); return }
    const editor = c.editor
    editor.focus()
    const before = editor.textContent || ''
    const spaced = (before.trim().length > 0 && !/\s$/.test(before) ? ' ' : '') + text
    try { document.execCommand('insertText', false, spaced) } catch (_) { /* judged below */ }
    await settle()
    if ((editor.textContent || '') !== before) return
    try {
      const data = new DataTransfer()
      data.setData('text/plain', spaced)
      editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    } catch (_) { /* judged below */ }
    await settle()
    if ((editor.textContent || '') !== before) return
    show('Не смог вставить — вот текст: ' + text, 'err')
  }

  // ── start ─────────────────────────────────────────────────────────────────
  // Last, after every function above exists: the first placement runs now, and
  // a button wired to a handler that is not yet initialised throws.
  // The composer is re-rendered by the app (sessions switch, the view
  // remounts), so the button is re-placed whenever it goes missing — checked
  // at most once per frame, because this page mutates on every streamed token.
  let queued = false
  new MutationObserver(() => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => { queued = false; place() })
  }).observe(document.body, { childList: true, subtree: true })
  place()
})()
