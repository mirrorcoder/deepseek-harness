// What dsh-ext-files puts into the page: a stylesheet and the script that adds
// the Download button (files.browser.js, read as text), through the same
// structured injection rows the other panels use.
import { readFileSync } from 'node:fs'

// The card's own class names are hashed per build; its theme tokens are not.
// The content layer of a card ignores the pointer (a full-card preview button
// lies under it), so the button takes the pointer back, as Open does.
export const CSS = `
.dsh-dl{display:inline-flex;flex:none;align-items:center;gap:4px;box-sizing:border-box;height:28px;padding:4px 9px;
pointer-events:auto;border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-button-floating-fill);
color:var(--dsw-alias-label-primary);font:12px/18px var(--dsw-font-family);text-decoration:none;cursor:pointer}
.dsh-dl:hover,.dsh-dl:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-dl svg{flex:none;width:14px;height:14px}
@media (pointer:coarse){.dsh-dl{min-height:44px;min-width:44px}}
`.trim()

export function filesScript() {
  return readFileSync(new URL('./files.browser.js', import.meta.url), 'utf8')
}

export function filesRows() {
  return [
    { kind: 'style', text: CSS },
    { kind: 'script', placement: 'body', text: filesScript() },
  ]
}
