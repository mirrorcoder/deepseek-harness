// Finding the projects on a machine, by the traces a project leaves.
//
// A "project" here is a directory carrying a marker every developer would
// recognise: a git repository, a compose file, a manifest. The walk stops at
// the first marker it finds on a branch — the packages inside a monorepo are
// not each a separate project to open — and never descends into the places
// where a depth-limited walk goes to die (node_modules, virtualenvs, caches).
//
// The filesystem is injected, so this is testable without one.
import { bothNames } from './paths.js'

/** A file or directory whose presence names the kind of project this is. */
export const MARKERS = {
  '.git': 'git',
  'docker-compose.yml': 'compose',
  'docker-compose.yaml': 'compose',
  'compose.yml': 'compose',
  'package.json': 'node',
  'pyproject.toml': 'python',
  'requirements.txt': 'python',
  'Cargo.toml': 'rust',
  'go.mod': 'go',
  'Makefile': 'make',
  'pom.xml': 'java',
}

/** Directories a walk must never enter: huge, generated, or not really files. */
export const SKIP = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__', '.cache', '.npm', '.pnpm-store',
  'dist', 'build', 'target', '.next', '.nuxt', 'vendor', 'site-packages',
  'proc', 'sys', 'dev', 'run', 'snap', 'lost+found', '.Trash',
])

/**
 * Walk a few roots and report the projects under them.
 *
 * @param {{roots: string[], depth?: number, limit?: number,
 *          readdir: (path: string) => Promise<{name: string, isDirectory: () => boolean}[]>,
 *          stat?: (path: string) => Promise<{mtimeMs: number}>,
 *          paths?: object}} options
 * @returns {Promise<{projects: object[], scanned: number, truncated: boolean}>}
 */
export async function findProjects(options) {
  const depth = Math.max(0, options.depth ?? 3)
  const limit = Math.max(1, options.limit ?? 60)
  const readdir = options.readdir
  const stat = options.stat
  const mapping = options.paths ?? {}
  const projects = []
  let scanned = 0
  let truncated = false

  /** Breadth-first: the shallow directories are the interesting ones. */
  let frontier = (options.roots ?? []).map((root) => ({ path: root, level: 0 }))
  const seen = new Set()

  while (frontier.length > 0) {
    const next = []
    for (const { path, level } of frontier) {
      if (projects.length >= limit) {
        truncated = true
        break
      }
      if (seen.has(path)) continue
      seen.add(path)
      let entries
      try {
        entries = await readdir(path)
      } catch {
        // Unreadable, gone, or not a directory: not an error worth reporting —
        // a scan of a whole machine always meets a few of these.
        continue
      }
      scanned += 1
      const names = new Set(entries.map((entry) => entry.name))
      const kinds = [...new Set(Object.entries(MARKERS)
        .filter(([marker]) => names.has(marker))
        .map(([, kind]) => kind))]
      if (kinds.length > 0) {
        projects.push({
          ...bothNames(path, mapping),
          name: path.split('/').filter(Boolean).pop() ?? path,
          kinds,
          changedAt: stat === undefined ? undefined : await stat(path).then((s) => s.mtimeMs, () => undefined),
        })
        // A project's insides are its own business.
        continue
      }
      if (level >= depth) continue
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (SKIP.has(entry.name)) continue
        if (entry.name.startsWith('.') && entry.name !== '.config') continue
        next.push({ path: `${path === '/' ? '' : path}/${entry.name}`, level: level + 1 })
      }
    }
    if (projects.length >= limit) {
      truncated = true
      break
    }
    frontier = next
  }

  projects.sort((a, b) => (b.changedAt ?? 0) - (a.changedAt ?? 0))
  return { projects: projects.slice(0, limit), scanned, truncated }
}
