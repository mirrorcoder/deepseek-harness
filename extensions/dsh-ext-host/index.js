// dsh-ext-host — the machine the harness runs ON, not just the container it
// runs IN.
//
// A containerised harness sees a slice of the world: its own workspace, its own
// process table, its own (absent) docker. Everything the operator actually owns
// — the projects on the disk, the stacks in docker, the services in systemd —
// is one boundary away. This extension lends that boundary out, deliberately
// and switchably:
//
//   • the host's disk is mounted read-write at /host (compose: DSH_HOST_ROOT),
//     so ordinary read/edit/grep/glob work on host files;
//   • `find_projects` walks it and reports what looks like a project;
//   • `add_workspace` registers any of them as a workspace, so a session can be
//     opened in it from the sidebar or from Telegram;
//   • `host_bash` runs a command ON the host through a unix-socket gateway
//     (deploy/hostd), which is how containers get created, stacks restarted,
//     services inspected.
//
// It ships OFF. The toggle is Settings → host → enabled: with it off no tool is
// registered at all, so the schemas cost nothing and there is no path across
// the boundary. With it on, `host_bash` still asks for approval unless the
// session runs under full access — and that question arrives as buttons
// wherever you are, including Telegram.
import { readdir, stat } from 'node:fs/promises'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { askHost, digest } from './gateway.js'
import { bothNames, normalize, toContainerPath, toHostPath } from './paths.js'
import { findProjects } from './scan.js'
import { approvalsOff, renderProjects, renderRun, stripUndefined } from './report.js'
import { PROJECTS_SCHEMA, RUN_SCHEMA, WORKSPACE_SCHEMA } from './schemas.js'

export const name = 'ext-host'
export const inject = ['tools']

export const Config = z.object({
  /** The switch. Off: no host tools exist at all. */
  enabled: z.boolean().default(false),
  /** Where the host's root is mounted inside this container. */
  hostRoot: z.string().default('/host'),
  /** Unix socket of the host gateway (deploy/hostd/dsh-hostd.mjs). */
  socketPath: z.string().default('/run/dsh-host/hostd.sock'),
  /** The container's workspace mount, and where it really lives on the host. */
  workspaceMount: z.string().default('/workspace'),
  workspaceHostPath: z.string().default('/root/dsh-data/workspace'),
  /** Where `find_projects` starts looking (host paths). */
  scanRoots: z.array(z.string()).default(['/root', '/opt', '/srv', '/home', '/var/www']),
  scanDepth: z.number().default(3),
  /** Default and maximum deadline for one host command. */
  timeoutSeconds: z.number().default(120),
  maxTimeoutSeconds: z.number().default(900),
  /**
   * When a host command needs a human first:
   *   outside-full-access — ask unless the session runs with approvals off (default)
   *   always — ask every time, even under full access
   *   never — never ask (the host is then as open as the workspace)
   */
  confirm: z.union(['outside-full-access', 'always', 'never']).default('outside-full-access'),
})

const SETTINGS_NS = 'host'

const BASH_DESCRIPTION = [
  'Run a shell command on the HOST machine (outside this container), as root.',
  'Use it for what the container cannot see or do: docker (ps, run, compose, logs) against the host daemon, systemctl, the host package manager, files outside the mounted tree.',
  'Paths are HOST paths here: /root/foo, not /host/root/foo. Inside the harness those same files are read and edited under /host — prefer the ordinary read/edit/grep tools for files and keep this for actions.',
  'Every call is written to the host audit log. Outside a full-access session the user is asked first, so expect a pause.',
].join(' ')

export function apply(ctx, initial) {
  let config = initial

  const mapping = () => ({
    hostRoot: config.hostRoot,
    workspaceMount: config.workspaceMount,
    workspaceHostPath: config.workspaceHostPath,
  })

  /** Registered tools, dropped and rebuilt whenever the switch moves. */
  let registered = []
  const clear = () => {
    for (const dispose of registered) {
      try {
        dispose()
      } catch {
        // a disposer that already ran is not a failure
      }
    }
    registered = []
  }

  // ── the tools ─────────────────────────────────────────────────────────────
  const hostBash = () => defineTool({
    name: 'host_bash',
    description: BASH_DESCRIPTION,
    timeoutMs: (config.maxTimeoutSeconds + 30) * 1000,
    parameters: {
      command: { type: 'string', required: true, description: 'The shell command, run by bash -lc on the host as root.' },
      cwd: { type: 'string', description: 'Working directory ON THE HOST (e.g. /root/aisignals). A /host/... path is accepted and translated.' },
      timeout_seconds: { type: 'integer', description: `Deadline for this command; default ${config.timeoutSeconds}.` },
    },
    output: {
      schema: RUN_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderRun(value) }],
    },
    presentCall: (args) => ({ card: 'generic', title: `host: ${digest(args.command)}`, kind: 'command', rawInput: args }),
    async execute(args) {
      if (!config.enabled) throw new Error('доступ к хосту выключен (Settings → host → enabled)')
      const cwd = args.cwd === undefined ? '/' : toHostPath(args.cwd, mapping()).path
      const seconds = Math.min(
        Math.max(Number(args.timeout_seconds ?? config.timeoutSeconds) || config.timeoutSeconds, 1),
        config.maxTimeoutSeconds,
      )
      const answer = await askHost(config.socketPath, {
        op: 'exec',
        command: String(args.command ?? ''),
        cwd,
        timeoutMs: seconds * 1000,
      }, { timeoutMs: (seconds + 10) * 1000 })
      if (answer?.ok !== true) throw new Error(answer?.error ?? 'хост не выполнил команду')
      return {
        exitCode: answer.exitCode ?? 0,
        stdout: answer.stdout ?? '',
        stderr: answer.stderr ?? '',
        durationMs: answer.durationMs ?? 0,
        timedOut: answer.timedOut === true,
        cwd: answer.cwd ?? cwd,
      }
    },
  })

  const findProjectsTool = () => defineTool({
    name: 'find_projects',
    description: [
      'List the projects on the host machine: directories carrying a git repository, a compose file or a language manifest.',
      'Returns both names of each directory — the host path and the path this harness reads it at — newest first.',
      'Use it to answer "what is on this machine" and to pick something to open; `add_workspace` then makes it a workspace.',
    ].join(' '),
    parameters: {
      root: { type: 'string', description: 'Where to look; default: the configured roots (/root, /opt, /srv, /home).' },
      depth: { type: 'integer', description: `How deep to walk; default ${config.scanDepth}.` },
      limit: { type: 'integer', description: 'Maximum number of projects to return; default 60.' },
    },
    output: {
      schema: PROJECTS_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderProjects(value) }],
    },
    presentCall: (args) => ({ card: 'generic', title: `Проекты на хосте${args.root ? `: ${args.root}` : ''}`, kind: 'other', rawInput: args }),
    async execute(args) {
      if (!config.enabled) throw new Error('доступ к хосту выключен (Settings → host → enabled)')
      const roots = args.root === undefined || String(args.root).trim().length === 0
        ? config.scanRoots
        : [String(args.root)]
      const found = await findProjects({
        // The walk happens in this container, over the mounted host disk.
        roots: roots.map((root) => toContainerPath(root, mapping()).path),
        depth: args.depth ?? config.scanDepth,
        limit: args.limit ?? 60,
        paths: mapping(),
        readdir: (path) => readdir(path, { withFileTypes: true }),
        stat: (path) => stat(path),
      })
      return found
    },
  })

  const addWorkspaceTool = () => defineTool({
    name: 'add_workspace',
    description: [
      'Register a directory as a workspace, so sessions can be opened in it and the sidebar groups them under it.',
      'Accepts a host path (/root/foo) or a path as this harness sees it (/host/root/foo, /workspace/foo); both name the same directory.',
      'Registering an already-registered directory is harmless — it returns the existing workspace.',
    ].join(' '),
    parameters: {
      path: { type: 'string', required: true, description: 'The directory to register.' },
      name: { type: 'string', description: 'Optional display name; defaults to the directory name.' },
    },
    output: {
      schema: WORKSPACE_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: `Воркспейс «${value.name}» → ${value.path}${value.hostPath && value.hostPath !== value.path ? ` (на хосте ${value.hostPath})` : ''}` }],
    },
    presentCall: (args) => ({ card: 'generic', title: `Воркспейс: ${args.path}`, kind: 'other', rawInput: args }),
    async execute(args) {
      const registry = ctx.get('workspaceRegistry')
      if (registry === undefined) throw new Error('в этой сборке нет реестра воркспейсов')
      const target = toContainerPath(String(args.path ?? ''), mapping()).path
      if (!target.startsWith('/')) throw new Error('нужен абсолютный путь')
      const stats = await stat(target).catch(() => undefined)
      if (stats === undefined || !stats.isDirectory()) throw new Error(`не вижу такой директории: ${target}`)
      // `create(path, title?)` is idempotent by canonical path: an already
      // registered directory comes back untouched rather than doubled.
      const created = args.name === undefined
        ? await registry.create(target)
        : await registry.create(target, String(args.name))
      return {
        id: created?.id,
        name: created?.name ?? normalize(target).split('/').filter(Boolean).pop(),
        ...bothNames(target, mapping()),
      }
    },
  })

  /**
   * Re-judge what exists, after a settings change or at boot.
   *
   * Each registration stands on its own. A tool that the registry refuses —
   * a schema it will not accept, a name already taken — must not take the
   * others down with it, and above all must not throw out of `apply`: a plugin
   * that throws while mounting mounts NOTHING, and in this build no logger
   * reports it. That is how host access once shipped switched-on and entirely
   * absent: one nested object in one output schema.
   */
  const sync = () => {
    clear()
    if (!config.enabled) return
    for (const build of [hostBash, findProjectsTool, addWorkspaceTool]) {
      try {
        registered.push(ctx.tools.register(build()))
      } catch (error) {
        // stderr, not ctx.logger: the logger is not available in this build and
        // the container log is where an operator actually looks.
        process.stderr.write(`ext-host: could not register a tool: ${error?.message ?? error}\n`)
      }
    }
  }

  // ── the gate: a command on the host asks first ────────────────────────────
  //
  // Expressed as a `tools/pre-execute` decision rather than as an approval call
  // of our own, so the harness owns the audit pair, the cancellation and the
  // policy — and the question surfaces wherever the operator is, browser or
  // Telegram.
  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.name !== 'host_bash' || !config.enabled) return next()
    if (config.confirm === 'never') return Promise.resolve({ kind: 'allow' })
    if (config.confirm === 'outside-full-access' && approvalsOff(ctx, exec)) {
      return Promise.resolve({ kind: 'allow' })
    }
    return Promise.resolve({
      kind: 'ask',
      reason: `Команда выполнится на ХОСТ-машине как root: ${digest(exec.arguments?.command, 200)}`,
    })
  })

  // The switch lives in settings, so it is flipped from the Settings page and
  // survives a restart. `installSection` calls onChange at attach, on every
  // committed change, and again if the provider goes away — which is exactly
  // when the set of registered tools has to be re-judged.
  let read = () => initial
  ctx.inject(['settings'], (sctx) => {
    sctx.settings.installSection(ctx, SETTINGS_NS, Config, initial, {
      setSource: (source) => {
        read = source
      },
      onChange: () => {
        // A settings document may carry an explicit undefined for a key it does
        // not mention; spreading that would erase the schema default behind it.
        config = { ...initial, ...stripUndefined(read()) }
        sync()
      },
    })
  })

  // Without a settings provider the composition config is the whole truth.
  sync()
  ctx.effect(() => () => clear(), 'ext-host: tools')
}
