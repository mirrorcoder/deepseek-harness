// Deterministic pre-pass over the span being compacted. Pure functions.
//
// The summariser model is good at prose and bad at exhaustive lists, so we
// extract the things a resumed agent most often needs verbatim — touched file
// paths, shell commands, and the user's own instructions — and hand them to
// the summariser as a ledger it must carry into the checkpoint.

const PATH_KEYS = ['path', 'file_path', 'filePath', 'file', 'target', 'directory', 'dir']
const LIST_PATH_KEYS = ['paths', 'files']
const COMMAND_KEYS = ['command', 'cmd']

function parseArgs(raw) {
  if (typeof raw !== 'string') return raw && typeof raw === 'object' ? raw : undefined
  try { return JSON.parse(raw) } catch { return undefined }
}

function textOf(message) {
  return (message.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

function hasToolResult(message) {
  return (message.content ?? []).some((b) => b.type === 'tool-result')
}

/** A user-authored message: role user, no tool results, not a synthetic checkpoint. */
export function isHumanMessage(message) {
  if (message.role !== 'user' || hasToolResult(message)) return false
  const kind = message.source?.kind
  if (kind !== undefined && kind !== 'user') return false
  const text = textOf(message)
  return text.length > 0 && !text.includes('<compacted-summary>')
}

/**
 * @param {readonly any[]} messages
 * @param {{maxPaths?: number, maxCommands?: number, maxDirectives?: number, directiveChars?: number}} [limits]
 */
export function buildLedger(messages, limits = {}) {
  const maxPaths = limits.maxPaths ?? 25
  const maxCommands = limits.maxCommands ?? 12
  const maxDirectives = limits.maxDirectives ?? 10
  const directiveChars = limits.directiveChars ?? 400
  const paths = new Map()      // path → last tool name (insertion order = first seen; we re-add to move to the end)
  const commands = []
  const directives = []
  for (const message of messages) {
    if (isHumanMessage(message)) {
      const t = textOf(message)
      directives.push(t.length > directiveChars ? `${t.slice(0, directiveChars)}…` : t)
      continue
    }
    for (const block of message.content ?? []) {
      if (block.type !== 'tool-call') continue
      const args = parseArgs(block.arguments)
      if (!args || typeof args !== 'object') continue
      for (const k of PATH_KEYS) {
        if (typeof args[k] === 'string' && args[k].length > 0 && args[k].length < 300) {
          paths.delete(args[k]); paths.set(args[k], block.name)
        }
      }
      for (const k of LIST_PATH_KEYS) {
        if (Array.isArray(args[k])) for (const p of args[k]) if (typeof p === 'string' && p.length < 300) { paths.delete(p); paths.set(p, block.name) }
      }
      for (const k of COMMAND_KEYS) {
        if (typeof args[k] === 'string' && args[k].length > 0) commands.push(args[k].length > 200 ? `${args[k].slice(0, 200)}…` : args[k])
      }
    }
  }
  return {
    paths: [...paths.entries()].slice(-maxPaths).map(([p, tool]) => ({ path: p, tool })),
    commands: commands.slice(-maxCommands),
    directives: directives.slice(-maxDirectives),
    humanMessages: directives.length,
  }
}

export function renderLedger(ledger) {
  const lines = ['### Ledger (extracted deterministically from the span; carry every item into the checkpoint)']
  lines.push(`User messages in span: ${ledger.humanMessages}`)
  lines.push('Most recent user instructions (verbatim, oldest → newest):')
  if (ledger.directives.length === 0) lines.push('- (none)')
  for (const d of ledger.directives) lines.push(`- "${d.replace(/\s+/g, ' ')}"`)
  lines.push('Files touched by tools (oldest → newest, last tool that touched each):')
  if (ledger.paths.length === 0) lines.push('- (none)')
  for (const p of ledger.paths) lines.push(`- ${p.path}  [${p.tool}]`)
  lines.push('Shell commands run (most recent):')
  if (ledger.commands.length === 0) lines.push('- (none)')
  for (const c of ledger.commands) lines.push(`- \`${c.replace(/\s+/g, ' ')}\``)
  return lines.join('\n')
}

/**
 * Split a message span into two halves at a human-message boundary near the
 * middle so tool-call/result pairs are never separated. Returns undefined when
 * no safe split exists.
 * @param {readonly any[]} messages
 */
export function splitAtHumanBoundary(messages) {
  if (messages.length < 4) return undefined
  const mid = Math.floor(messages.length / 2)
  const candidates = []
  for (let i = 1; i < messages.length; i++) if (isHumanMessage(messages[i])) candidates.push(i)
  if (candidates.length === 0) return undefined
  let best = candidates[0]
  for (const c of candidates) if (Math.abs(c - mid) < Math.abs(best - mid)) best = c
  if (best <= 0 || best >= messages.length) return undefined
  return [messages.slice(0, best), messages.slice(best)]
}
