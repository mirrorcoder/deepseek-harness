// Pure rendering of the "what this fork adds" panel: markdown in, markup out.
// No dsh or node imports, so the parser and the escaping are unit-testable.

/** HTML-escape a text node or attribute value. */
export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * Parse our CHANGELOG into release entries.
 * Recognises `## vX.Y.Z — DATE` headings; everything until the next heading is
 * that release's body. Bullets keep their nesting as flat lines; `**bold**`
 * and `` `code` `` are the only inline markup carried over.
 */
export function parseChangelog(markdown) {
  const entries = []
  let current
  for (const line of String(markdown).split('\n')) {
    const heading = /^##\s+v(\d+\.\d+\.\d+)\s*(?:—|-|–)?\s*(.*)$/.exec(line)
    if (heading !== null) {
      current = { version: heading[1], date: heading[2].trim(), lines: [] }
      entries.push(current)
      continue
    }
    if (current === undefined) continue
    if (/^##\s/.test(line)) { current = undefined; continue }
    current.lines.push(line)
  }
  return entries.map((entry) => ({
    version: entry.version,
    date: entry.date,
    body: entry.lines.join('\n').trim(),
  }))
}

/** The few inline marks our changelog uses, after escaping. */
function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
}

/** Render one release body: bullets become a list, prose becomes paragraphs. */
export function renderBody(body) {
  const out = []
  let list = []
  const flush = () => {
    if (list.length > 0) out.push(`<ul>${list.join('')}</ul>`)
    list = []
  }
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (line.length === 0) { flush(); continue }
    const bullet = /^[-*]\s+(.*)$/.exec(line)
    if (bullet !== null) { list.push(`<li>${inline(bullet[1])}</li>`); continue }
    if (list.length > 0) {
      // continuation of the previous bullet
      list[list.length - 1] = list[list.length - 1].replace(/<\/li>$/, ` ${inline(line)}</li>`)
      continue
    }
    out.push(`<p>${inline(line)}</p>`)
  }
  flush()
  return out.join('')
}

/** The whole panel body: identity, what is installed, then the release history. */
export function renderPanel(info, entries) {
  const exts = Object.entries(info.extensions ?? {})
  const rows = exts.length === 0
    ? '<p>No extensions recorded in this build.</p>'
    : `<ul>${exts.map(([n, v]) => `<li><code>${escapeHtml(n)}</code> <span class="dsh-about-dim">${escapeHtml(v)}</span></li>`).join('')}</ul>`
  const releases = entries.length === 0
    ? '<p>No changelog was baked into this image.</p>'
    : entries.map((e) => `<section class="dsh-about-rel"><h3>v${escapeHtml(e.version)}${e.date ? ` <span class="dsh-about-dim">${escapeHtml(e.date)}</span>` : ''}</h3>${renderBody(e.body)}</section>`).join('')
  const source = info.repository
    ? `<p class="dsh-about-dim">Source <a href="${escapeHtml(info.repository)}" target="_blank" rel="noreferrer noopener">${escapeHtml(info.repository)}</a>${info.mirror ? ` · mirror <code>git clone ${escapeHtml(info.mirror)}</code>` : ''}</p>`
    : ''
  return [
    `<h2>This harness is a fork</h2>`,
    `<p><strong>v${escapeHtml(info.forkVersion ?? 'unknown')}</strong> built on upstream <code>${escapeHtml(info.upstreamBase ?? 'unknown')}</code>`,
    info.forkCommit && info.forkCommit !== 'unknown' ? ` · commit <code>${escapeHtml(info.forkCommit)}</code>` : '',
    info.builtAt && info.builtAt !== 'unknown' ? ` · built ${escapeHtml(info.builtAt)}` : '',
    `</p>`,
    source,
    `<h3>Added on top of upstream</h3>`,
    rows,
    `<h3>What changed, and when</h3>`,
    releases,
  ].join('')
}

/** Everything the page needs: one button, one dialog, scoped styles, one script. */
export function panelRows(info, entries) {
  const css = `
.dsh-about-btn{position:fixed;right:14px;bottom:14px;z-index:2147483000;width:30px;height:30px;border-radius:50%;
border:1px solid rgba(255,255,255,.18);background:rgba(28,28,30,.72);color:#d8d8dc;font:600 14px/28px ui-sans-serif,system-ui,sans-serif;
text-align:center;cursor:pointer;opacity:.45;transition:opacity .15s ease,transform .15s ease;backdrop-filter:blur(6px)}
.dsh-about-btn:hover{opacity:1;transform:translateY(-1px)}
.dsh-about-wrap{position:fixed;inset:0;z-index:2147483001;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55)}
.dsh-about-wrap[data-open="1"]{display:flex}
.dsh-about-card{max-width:760px;max-height:82vh;overflow:auto;background:#1c1c1e;color:#e6e6ea;border:1px solid rgba(255,255,255,.12);
border-radius:14px;padding:22px 26px;font:14px/1.55 ui-sans-serif,system-ui,sans-serif;box-shadow:0 18px 60px rgba(0,0,0,.5)}
.dsh-about-card h2{margin:0 0 10px;font-size:19px}
.dsh-about-card h3{margin:18px 0 6px;font-size:14px;letter-spacing:.02em;text-transform:uppercase;color:#a0a0a8}
.dsh-about-card ul{margin:6px 0;padding-left:18px}
.dsh-about-card li{margin:3px 0}
.dsh-about-card p{margin:6px 0}
.dsh-about-card code{background:rgba(255,255,255,.08);border-radius:4px;padding:1px 5px;font-size:12.5px}
.dsh-about-card a{color:#7fb2ff}
.dsh-about-dim{color:#8e8e96}
.dsh-about-rel{border-top:1px solid rgba(255,255,255,.08);padding-top:10px;margin-top:12px}
.dsh-about-close{float:right;border:0;background:transparent;color:#8e8e96;font-size:20px;cursor:pointer;line-height:1}
`.trim()

  const html = `<button class="dsh-about-btn" id="dsh-about-open" type="button" aria-label="About this harness build" title="About this build">i</button>`
    + `<div class="dsh-about-wrap" id="dsh-about-wrap" role="dialog" aria-modal="true" aria-label="About this harness build">`
    + `<div class="dsh-about-card"><button class="dsh-about-close" id="dsh-about-close" type="button" aria-label="Close">&times;</button>`
    + renderPanel(info, entries)
    + `</div></div>`

  // No `</script` may appear in an inline script row; the markup above is the
  // dialog's only content, so the script itself stays free of markup.
  const script = `(function(){
var o=document.getElementById('dsh-about-open'),w=document.getElementById('dsh-about-wrap'),c=document.getElementById('dsh-about-close')
if(!o||!w||!c)return
function set(v){w.setAttribute('data-open',v?'1':'0')}
o.addEventListener('click',function(){set(true)})
c.addEventListener('click',function(){set(false)})
w.addEventListener('click',function(e){if(e.target===w)set(false)})
document.addEventListener('keydown',function(e){if(e.key==='Escape')set(false)})
})()`

  return [
    { kind: 'style', text: css },
    { kind: 'html', placement: 'body', html },
    { kind: 'script', placement: 'body', text: script },
  ]
}
