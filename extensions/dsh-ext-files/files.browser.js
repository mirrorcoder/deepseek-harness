// A Download button on every deliverable card. Injected into the page by
// dsh-ext-files.
//
// A card is `[data-presented-file]`; its full-card preview button carries the
// file's absolute path in `title` — the tooltip the operator sees. Both are
// part of the upstream markup, unlike the hashed class names. The button is a
// plain link to the download route: the browser sends the session cookie
// itself, and the server's Content-Disposition names the file.
;(() => {
  if (window.__dshFiles) return
  window.__dshFiles = true

  const ROUTE = '/api/files/download'
  const ICON = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M8 2.5v7.5M4.8 7 8 10.2 11.2 7M3 13h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'

  const nameOf = (path) => path.split('/').filter(Boolean).pop() || 'file'

  const place = () => {
    for (const card of document.querySelectorAll('[data-presented-file]')) {
      if (card.querySelector('.dsh-dl')) continue
      const titled = card.querySelector('button[title]')
      const path = titled && titled.getAttribute('title')
      if (!path || path.charAt(0) !== '/') continue
      // Open: the card's labelled button that is not the full-card overlay.
      const open = Array.from(card.querySelectorAll('button')).find((b) => b !== titled && b.textContent.trim().length > 0)
      const split = open && open.parentElement
      if (!split || !split.parentElement) continue
      const name = nameOf(path)
      const link = document.createElement('a')
      link.className = 'dsh-dl'
      link.href = ROUTE + '?path=' + encodeURIComponent(path)
      link.setAttribute('download', name)
      link.title = 'Скачать ' + name
      link.setAttribute('aria-label', 'Скачать ' + name)
      link.innerHTML = ICON + '<span>Скачать</span>'
      // the card itself opens a preview on click; a download must not
      link.addEventListener('click', (event) => event.stopPropagation())
      split.parentElement.insertBefore(link, split)
    }
  }

  // Cards appear as the conversation streams and re-render when sessions
  // switch: re-placed at most once per frame, as the microphone is.
  let queued = false
  new MutationObserver(() => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => { queued = false; place() })
  }).observe(document.body, { childList: true, subtree: true })
  place()
})()
