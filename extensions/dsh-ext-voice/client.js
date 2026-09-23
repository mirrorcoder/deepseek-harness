// What dsh-ext-voice puts into the page: a stylesheet and the dictation script
// (mic.browser.js, read as text). Delivered through the same structured
// injection rows the ✈ and "i" panels use, so nothing upstream is edited.
import { readFileSync } from 'node:fs'

export const CSS = `
.dsh-mic[data-state="recording"]{color:#ff5a52 !important;animation:dsh-mic-pulse 1.1s ease-in-out infinite}
.dsh-mic[data-state="busy"]{opacity:.55;cursor:progress}
@keyframes dsh-mic-pulse{0%,100%{opacity:1}50%{opacity:.45}}
.dsh-mic-pill{position:fixed;left:50%;bottom:118px;transform:translateX(-50%) translateY(6px);z-index:2147483000;
max-width:min(620px,90vw);padding:7px 14px;border-radius:999px;background:rgba(28,28,30,.92);color:#e6e6ea;
border:1px solid rgba(255,255,255,.14);font:13px/1.4 ui-sans-serif,system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.35);
opacity:0;pointer-events:none;transition:opacity .15s ease,transform .15s ease;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-mic-pill[data-open="1"]{opacity:1;transform:translateX(-50%) translateY(0)}
.dsh-mic-pill[data-kind="rec"]{color:#ffb4ae}
.dsh-mic-pill[data-kind="err"]{background:rgba(70,20,20,.94);color:#ffb4ae}
`.trim()

export function micScript() {
  return readFileSync(new URL('./mic.browser.js', import.meta.url), 'utf8')
}

export function voiceRows() {
  return [
    { kind: 'style', text: CSS },
    { kind: 'script', placement: 'body', text: micScript() },
  ]
}
