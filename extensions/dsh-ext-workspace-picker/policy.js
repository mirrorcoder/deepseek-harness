// Pure listing policy: which rows to dim, and how places merge into a level.
// No dsh or node imports, so every rule here is unit-testable on its own.

/**
 * Directories that are never the answer to "pick a workspace": package caches,
 * build output, virtualenvs, VCS internals. They stay in the listing but are
 * flagged `hidden`, so the dialog's "Show hidden files" still reveals them.
 */
export const DEFAULT_NOISE = [
  '.git', '.hg', '.svn',
  'node_modules', '.pnpm-store', '.npm', '.yarn', 'bower_components',
  '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox', '.eggs',
  'dist', 'build', 'out', 'target', '.next', '.nuxt', '.turbo', '.parcel-cache', '.gradle',
  '.cache', '.terraform', 'vendor',
]

/** Flag a row hidden when its name is dot-prefixed (already flagged) or noise. */
export function applyNoise(entry, noise) {
  return entry.hidden || noise.includes(entry.name) ? { ...entry, hidden: true } : entry
}

/**
 * Merge configured places into a level's rows. Places are jump targets that
 * may live outside the listed directory; a place already present as a real
 * child is dropped rather than duplicated, and so is one pointing at the
 * directory being listed.
 * @param entries - rows the backend produced for `listedPath`.
 * @param places - `{ name, path }` targets that exist on disk, in config order.
 * @param listedPath - absolute path of the level being listed.
 */
export function mergePlaces(entries, places, listedPath) {
  const taken = new Set(entries.map((e) => e.path))
  const rows = []
  for (const place of places) {
    if (place.path === listedPath || taken.has(place.path)) continue
    taken.add(place.path)
    rows.push({ name: place.name, path: place.path, hidden: false })
  }
  return [...rows, ...entries]
}

/**
 * The directory a listing should land on: an explicit request wins, then the
 * configured default, then the backend's own default (the account's home).
 */
export function landingPath(requested, configured, cwd) {
  if (requested !== undefined) return requested
  const fallback = configured.length > 0 ? configured : cwd
  return fallback.length > 0 ? fallback : undefined
}

/**
 * The breadcrumb Home anchor. It must not follow the level being listed —
 * Home is one fixed place to jump back to — so it is the configured anchor,
 * else the landing root, and `undefined` when neither is configured (the
 * backend's own home value then stands).
 */
export function homeAnchorPath(configuredAnchor, configuredDefault, cwd) {
  for (const candidate of [configuredAnchor, configuredDefault, cwd]) {
    if (candidate.length > 0) return candidate
  }
  return undefined
}
