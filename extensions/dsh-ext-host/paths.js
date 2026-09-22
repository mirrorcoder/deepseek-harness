// Two machines, two names for the same file.
//
// The harness lives in a container where the host's disk is mounted at `/host`
// and its own workspace at `/workspace`. The host knows those same files as `/`
// and as whatever directory it lent out. Every path that crosses the boundary —
// a directory the agent found, a workspace it wants to register, a cwd for a
// command that will run on the host — has to be translated, or it silently
// points at nothing.
//
// Pure: no fs, no dsh. The mapping is the whole of it.

/** Collapse repeated slashes and drop a trailing one (but never make it empty). */
export function normalize(path) {
  const text = String(path ?? '').trim()
  if (text.length === 0) return ''
  const collapsed = text.replace(/\/+/g, '/')
  return collapsed.length > 1 ? collapsed.replace(/\/$/, '') : collapsed
}

/** Whether `path` is `root` itself or lies inside it. */
export function isUnder(path, root) {
  const a = normalize(path)
  const b = normalize(root)
  if (a.length === 0 || b.length === 0) return false
  if (b === '/') return a.startsWith('/')
  return a === b || a.startsWith(`${b}/`)
}

const DEFAULTS = {
  /** Where the host's root is mounted inside the container. */
  hostRoot: '/host',
  /** The container's workspace mount. */
  workspaceMount: '/workspace',
  /** Where that workspace really lives on the host. */
  workspaceHostPath: '/root/dsh-data/workspace',
}

/**
 * The name the HOST knows a container path by.
 * @returns {{path: string, mapped: boolean}} `mapped` is false for a path that
 *   exists only inside the container — the caller must not pretend otherwise.
 */
export function toHostPath(path, options = {}) {
  const { hostRoot, workspaceMount, workspaceHostPath } = { ...DEFAULTS, ...options }
  const target = normalize(path)
  if (target.length === 0) return { path: '', mapped: false }
  if (isUnder(target, hostRoot)) {
    const rest = target.slice(normalize(hostRoot).length)
    return { path: rest.length === 0 ? '/' : rest, mapped: true }
  }
  if (isUnder(target, workspaceMount)) {
    const rest = target.slice(normalize(workspaceMount).length)
    return { path: normalize(`${workspaceHostPath}${rest}`), mapped: true }
  }
  return { path: target, mapped: false }
}

/**
 * The name the CONTAINER knows a host path by. A host path that is really the
 * workspace comes back as the workspace, not as a second route to the same
 * files: two names for one directory is how a session ends up split in two.
 * @returns {{path: string, mapped: boolean}}
 */
export function toContainerPath(path, options = {}) {
  const { hostRoot, workspaceMount, workspaceHostPath } = { ...DEFAULTS, ...options }
  const target = normalize(path)
  if (target.length === 0 || !target.startsWith('/')) return { path: target, mapped: false }
  // Already a container path: leave it exactly as it is.
  if (isUnder(target, hostRoot) || isUnder(target, workspaceMount)) return { path: target, mapped: true }
  if (isUnder(target, workspaceHostPath)) {
    const rest = target.slice(normalize(workspaceHostPath).length)
    return { path: normalize(`${workspaceMount}${rest}`), mapped: true }
  }
  return { path: normalize(`${hostRoot}${target}`), mapped: true }
}

/** Both names of one directory, for an answer a human can act on either side of. */
export function bothNames(containerPath, options = {}) {
  return {
    path: normalize(containerPath),
    hostPath: toHostPath(containerPath, options).path,
  }
}
