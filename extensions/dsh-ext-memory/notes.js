// What the harness remembers between sessions, and how it is laid out.
//
// A compaction checkpoint survives one session. Everything learned the hard way
// — where a service really lives, which command actually deploys it, what the
// owner already decided — is worth more than that and belongs outside the
// window entirely: on disk, loaded into the system prompt at the start of every
// session in the same workspace.
//
// Pure: paths, names, rendering and budget. No fs, no dsh.

/** Directory name for one workspace's notes: its path, flattened and safe. */
export function slugOf(cwd) {
  const text = String(cwd ?? '').trim()
  if (text.length === 0 || text === '/') return 'root'
  return text
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'root'
}

/** File name for one note: a slug the model chose, never a path. */
export function fileNameOf(name) {
  const clean = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60)
  if (clean.length === 0) throw new Error('note name must contain letters or digits')
  return `${clean}.md`
}

/** The note name a file name came from. */
export function nameOf(fileName) {
  return String(fileName ?? '').replace(/\.md$/i, '')
}

/**
 * The prompt section built from a set of notes.
 *
 * Newest first, because a budget cuts the tail and the newest fact is the one
 * most likely to still be true. A note too long to fit is dropped whole rather
 * than truncated: half a fact reads like a complete one and is how a resumed
 * agent ends up confidently wrong.
 */
export function renderNotes(notes, options = {}) {
  const maxChars = options.maxChars ?? 6000
  const title = options.title ?? 'Memory (persisted across sessions, newest first)'
  const usable = (notes ?? []).filter((note) => String(note?.body ?? '').trim().length > 0)
  if (usable.length === 0) return ''
  const ordered = [...usable].sort((a, b) => (b.changedAt ?? 0) - (a.changedAt ?? 0))
  const head = `## ${title}`
  const lines = [head]
  let used = head.length
  let dropped = 0
  for (const note of ordered) {
    const block = `### ${nameOf(note.name)}\n${String(note.body).trim()}`
    if (used + block.length + 2 > maxChars) {
      dropped += 1
      continue
    }
    lines.push(block)
    used += block.length + 2
  }
  if (lines.length === 1) return ''
  if (dropped > 0) lines.push(`_(${dropped} older note(s) not shown; they are on disk under the memory directory.)_`)
  return lines.join('\n\n')
}

/** One line per note, for a tool answer that has to fit in a glance. */
export function listNotes(notes) {
  if ((notes ?? []).length === 0) return 'Заметок пока нет.'
  return [...notes]
    .sort((a, b) => (b.changedAt ?? 0) - (a.changedAt ?? 0))
    .map((note) => `- ${nameOf(note.name)} (${String(note.body ?? '').trim().length} симв.)`)
    .join('\n')
}
