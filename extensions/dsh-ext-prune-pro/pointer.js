// What a pruned tool result should leave behind, and for which tools.
//
// The upstream pruner cuts every big result the same way: keep a head, keep a
// tail, drop the middle. That is right for output that exists only here — a
// command's stdout, a test run. It is wasteful for output that is a COPY of
// something still on disk: a file read leaves 2.5k characters of a file the
// agent can re-read in one call.
//
// So results split in two. Regenerable ones collapse to a pointer naming the
// source; everything else keeps the head/tail treatment. Pure: no fs, no dsh.

/**
 * Tools whose result is a copy of something still retrievable.
 *
 * `read_image` is deliberately NOT here. Its result is a short text envelope
 * plus an image block, so the text never reaches the threshold anyway — and if
 * it ever did, collapsing it would throw the picture away, which no amount of
 * re-reading brings back into THIS conversation cheaply.
 */
export const REGENERABLE = {
  read: 'file',
  glob: 'listing',
  find_projects: 'listing',
}

/**
 * Which argument names the source, per tool, most specific first.
 *
 * Order is not cosmetic: `glob` takes both a `pattern` and a `path`, and a
 * pointer that names the directory sends the agent back to run the same tool
 * with the pattern lost — a re-read that returns something else is worse than
 * no pointer at all.
 */
const SOURCE_KEYS = {
  glob: ['pattern', 'path'],
  find_projects: ['root', 'path'],
  default: ['path', 'file_path', 'filePath', 'file', 'pattern', 'root', 'directory', 'dir'],
}

/** The source a call names, as a short string, or undefined. */
export function sourceOf(args, tool) {
  const parsed = typeof args === 'string' ? safeParse(args) : args
  if (parsed === undefined || parsed === null || typeof parsed !== 'object') return undefined
  const keys = SOURCE_KEYS[tool] ?? SOURCE_KEYS.default
  for (const key of keys) {
    const value = parsed[key]
    if (typeof value === 'string' && value.length > 0) return value.slice(0, 200)
  }
  return undefined
}

function safeParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * The line left in place of a regenerable result.
 *
 * It says three things, because a pointer that omits any of them costs a
 * retry: what was here, how to get it again, and how to get THIS version back
 * (the file may have changed since — the original result is still in the log).
 */
export function pointerText(options) {
  const { tool, source, chars, seq } = options
  const kind = REGENERABLE[tool] ?? 'result'
  const what = source === undefined ? `a ${kind}` : `${kind} \`${source}\``
  return [
    `[pruned: the ${tool} result for ${what} (${chars} characters) was removed to free context.`,
    source === undefined
      ? `Run ${tool} again to get the current content.`
      : `Run \`${tool}\` on \`${source}\` again for the CURRENT content` + (seq === undefined ? '.' : `, or \`session_event_read\` at seq ${seq} for exactly this version.`),
    'Do not guess at what it said.]',
  ].join(' ')
}

/**
 * Whether one result is worth collapsing to a pointer.
 * @returns true when the tool is regenerable and the text is big enough to matter.
 */
export function worthPointer(tool, chars, minChars) {
  if (REGENERABLE[tool] === undefined) return false
  return chars >= minChars
}

/** Sum of the text characters in a content-block array. */
export function textChars(blocks) {
  let chars = 0
  for (const block of blocks ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') chars += Array.from(block.text).length
  }
  return chars
}
