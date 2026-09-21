// How a workspace and a session become a Telegram topic. Pure.
//
// The mapping is the whole point of the bridge: one topic per session, named
// and coloured so the thread list reads like the sidebar — threads of the same
// project share a colour, and each title says which project it belongs to.

/** The six colours Telegram accepts for a topic icon. */
export const TOPIC_COLORS = [0x6FB9F0, 0xFFD67E, 0xCB86DB, 0x8EEE98, 0xFF93B2, 0xFB6F5F]

/** Stable colour for a workspace: the same project always looks the same. */
export function colorFor(key) {
  let hash = 0
  for (const character of String(key ?? '')) hash = (hash * 31 + character.codePointAt(0)) >>> 0
  return TOPIC_COLORS[hash % TOPIC_COLORS.length]
}

/** Short name of a directory, for titles: `/workspace/projects/site` → `site`. */
export function shortPath(path) {
  const parts = String(path ?? '').split('/').filter((part) => part.length > 0)
  return parts.length === 0 ? '' : parts[parts.length - 1]
}

/**
 * The workspace a session belongs to: the registered workspace whose path is
 * the longest prefix of the session's directory.
 */
export function workspaceOf(cwd, workspaces) {
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined
  let best
  for (const workspace of workspaces ?? []) {
    const path = workspace.path
    if (typeof path !== 'string' || path.length === 0) continue
    if (cwd !== path && !cwd.startsWith(path.endsWith('/') ? path : `${path}/`)) continue
    if (best === undefined || path.length > best.path.length) best = workspace
  }
  return best
}

/** `harness · Fix the login bug`, bounded to Telegram's topic-name limit. */
export function topicName(workspace, title, max = 96) {
  const project = workspace === undefined ? '' : (workspace.name ?? shortPath(workspace.path))
  const subject = String(title ?? '').replace(/\s+/g, ' ').trim()
  const composed = project.length > 0 && subject.length > 0
    ? `${project} · ${subject}`
    : (subject.length > 0 ? subject : (project.length > 0 ? `${project} · новая сессия` : 'dsh сессия'))
  return composed.length <= max ? composed : `${composed.slice(0, max - 1)}…`
}

/** Everything needed to open a topic for one session. */
export function topicSpec(session, workspaces) {
  const workspace = workspaceOf(session.cwd, workspaces)
  return {
    name: topicName(workspace, session.title),
    iconColor: colorFor(workspace?.path ?? session.cwd ?? 'dsh'),
    workspace,
  }
}
