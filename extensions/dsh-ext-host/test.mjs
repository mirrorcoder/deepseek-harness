// Host access. Run inside the dsh container:
//   node --test /data/dsh/profiles/web/node_modules/dsh-ext-host/test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { bothNames, isUnder, normalize, toContainerPath, toHostPath } from './paths.js'
import { MARKERS, SKIP, findProjects } from './scan.js'
import { askHost, digest, explain } from './gateway.js'
import { approvalsOff, renderProjects, renderRun, stripUndefined } from './report.js'
import { PROJECTS_SCHEMA, RUN_SCHEMA, WORKSPACE_SCHEMA } from './schemas.js'

const MAP = { hostRoot: '/host', workspaceMount: '/workspace', workspaceHostPath: '/root/dsh-data/workspace' }

test('a path has two names, and the translation is a round trip', () => {
  assert.deepEqual(toHostPath('/host/root/aisignals', MAP), { path: '/root/aisignals', mapped: true })
  assert.deepEqual(toContainerPath('/root/aisignals', MAP), { path: '/host/root/aisignals', mapped: true })
  assert.equal(toHostPath(toContainerPath('/opt/smm', MAP).path, MAP).path, '/opt/smm')
  assert.equal(toContainerPath(toHostPath('/host/srv/git', MAP).path, MAP).path, '/host/srv/git')
})

test('the workspace is the workspace, not a second route to the same files', () => {
  // A host path that IS the mounted workspace must come back as /workspace…
  assert.deepEqual(toContainerPath('/root/dsh-data/workspace/projects/x', MAP), { path: '/workspace/projects/x', mapped: true })
  // …and back the other way it is the real host directory, not /host/workspace.
  assert.deepEqual(toHostPath('/workspace/projects/x', MAP), { path: '/root/dsh-data/workspace/projects/x', mapped: true })
})

test('the mount point itself maps to the root of the host', () => {
  assert.deepEqual(toHostPath('/host', MAP), { path: '/', mapped: true })
  assert.deepEqual(toContainerPath('/', MAP), { path: '/host', mapped: true })
})

test('a container-only path is reported as unmapped rather than invented', () => {
  assert.deepEqual(toHostPath('/data/dsh/settings.yaml', MAP), { path: '/data/dsh/settings.yaml', mapped: false })
  assert.deepEqual(toHostPath('', MAP), { path: '', mapped: false })
  assert.deepEqual(toContainerPath('relative/path', MAP), { path: 'relative/path', mapped: false })
})

test('normalisation is not a prefix match: /hostile is not inside /host', () => {
  assert.equal(isUnder('/hostile/x', '/host'), false)
  assert.equal(isUnder('/host', '/host'), true)
  assert.equal(isUnder('/host/x', '/host'), true)
  assert.equal(normalize('/host//root/x/'), '/host/root/x')
  assert.equal(normalize('/'), '/')
  assert.deepEqual(toHostPath('/hostile/x', MAP), { path: '/hostile/x', mapped: false })
})

test('both names travel together, so an answer works on either side', () => {
  assert.deepEqual(bothNames('/host/opt/uts', MAP), { path: '/host/opt/uts', hostPath: '/opt/uts' })
})

/** A filesystem made of literals: directory → entry names. */
function fakeFs(tree) {
  return {
    readdir: async (path) => {
      const entries = tree[path]
      if (entries === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return entries.map((name) => ({ name, isDirectory: () => tree[`${path === '/' ? '' : path}/${name}`] !== undefined }))
    },
    stat: async () => ({ mtimeMs: 1 }),
  }
}

test('a project is a directory carrying a marker, and its insides are not more projects', async () => {
  const fs = fakeFs({
    '/host/root': ['aisignals', 'notes.txt'],
    '/host/root/aisignals': ['.git', 'apps', 'docker-compose.yml'],
    '/host/root/aisignals/apps': ['api'],
    '/host/root/aisignals/apps/api': ['package.json'],
  })
  const found = await findProjects({ roots: ['/host/root'], depth: 3, paths: MAP, ...fs })
  assert.equal(found.projects.length, 1)
  assert.deepEqual(found.projects[0].kinds.sort(), ['compose', 'git'])
  assert.equal(found.projects[0].hostPath, '/root/aisignals')
  assert.equal(found.projects[0].name, 'aisignals')
})

test('the walk stays out of the places a depth limit goes to die', async () => {
  const fs = fakeFs({
    '/host/srv': ['app', 'node_modules'],
    '/host/srv/node_modules': ['left-pad'],
    '/host/srv/node_modules/left-pad': ['package.json'],
    '/host/srv/app': ['pyproject.toml'],
  })
  const found = await findProjects({ roots: ['/host/srv'], depth: 3, paths: MAP, ...fs })
  assert.deepEqual(found.projects.map((p) => p.hostPath), ['/srv/app'])
  assert.ok(SKIP.has('node_modules') && SKIP.has('.venv'))
  assert.equal(MARKERS['.git'], 'git')
})

test('depth is a limit, not a suggestion', async () => {
  const fs = fakeFs({
    '/host/opt': ['a'],
    '/host/opt/a': ['b'],
    '/host/opt/a/b': ['c'],
    '/host/opt/a/b/c': ['go.mod'],
  })
  assert.equal((await findProjects({ roots: ['/host/opt'], depth: 1, paths: MAP, ...fs })).projects.length, 0)
  assert.equal((await findProjects({ roots: ['/host/opt'], depth: 3, paths: MAP, ...fs })).projects.length, 1)
})

test('an unreadable directory is skipped, not fatal', async () => {
  const fs = fakeFs({ '/host/root': ['secret', 'app'], '/host/root/app': ['Cargo.toml'] })
  const found = await findProjects({ roots: ['/host/root', '/host/nope'], depth: 2, paths: MAP, ...fs })
  assert.deepEqual(found.projects.map((p) => p.hostPath), ['/root/app'])
})

test('a limit truncates and says so', async () => {
  const tree = { '/host/root': ['a', 'b', 'c'] }
  for (const name of ['a', 'b', 'c']) tree[`/host/root/${name}`] = ['.git']
  const found = await findProjects({ roots: ['/host/root'], depth: 2, limit: 2, paths: MAP, ...fakeFs(tree) })
  assert.equal(found.projects.length, 2)
  assert.equal(found.truncated, true)
})

/** A socket made of an emitter: connect, expect a request, answer it. */
function fakeSocket(answer, options = {}) {
  const socket = new EventEmitter()
  socket.setEncoding = () => {}
  socket.destroy = () => {}
  socket.write = (line) => {
    socket.written = line
    if (options.silent === true) return
    queueMicrotask(() => socket.emit('data', `${JSON.stringify(answer)}\n`))
  }
  return socket
}

test('the gateway speaks one request, one answer, one line', async () => {
  const socket = fakeSocket({ ok: true, exitCode: 0, stdout: 'CONTAINER ID' })
  const asked = askHost('/run/dsh-host/hostd.sock', { op: 'exec', command: 'docker ps' }, { connect: () => socket })
  queueMicrotask(() => socket.emit('connect'))
  const answer = await asked
  assert.equal(answer.stdout, 'CONTAINER ID')
  assert.deepEqual(JSON.parse(socket.written), { op: 'exec', command: 'docker ps' })
  assert.ok(socket.written.endsWith('\n'), 'кадр закрывается переводом строки')
})

test('a missing gateway says how to switch it on', async () => {
  const socket = fakeSocket({}, { silent: true })
  const asked = askHost('/run/dsh-host/hostd.sock', { op: 'ping' }, { connect: () => socket })
  queueMicrotask(() => socket.emit('error', Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' })))
  await assert.rejects(asked, /host-access\.sh on/)
  assert.match(explain({ code: 'EACCES' }, '/s.sock'), /uid 1000/)
  assert.match(explain({ code: 'ECONNREFUSED' }, '/s.sock'), /systemctl restart dsh-hostd/)
})

test('a gateway that answers nothing is an error, not a hang', async () => {
  const socket = fakeSocket({}, { silent: true })
  const asked = askHost('/s.sock', { op: 'ping' }, { connect: () => socket })
  queueMicrotask(() => {
    socket.emit('connect')
    socket.emit('close')
  })
  await assert.rejects(asked, /ничего не ответив/)
})

test('the deadline belongs to the caller, not to the host', async () => {
  const socket = fakeSocket({}, { silent: true })
  const asked = askHost('/s.sock', { op: 'exec' }, { connect: () => socket, timeoutMs: 20 })
  queueMicrotask(() => socket.emit('connect'))
  await assert.rejects(asked, /не ответил/)
})

test('under full access the gate steps aside instead of blocking', () => {
  // The approval service resolves every request as rejected while the policy is
  // 'never', so ASKING there would deny exactly the mode chosen to be open.
  const session = {}
  const ctxWith = (policy) => ({ get: () => ({ overrideOf: () => policy, config: { policy: 'ask' } }) })
  assert.equal(approvalsOff(ctxWith('never'), { agent: { session } }), true)
  assert.equal(approvalsOff(ctxWith('ask'), { agent: { session } }), false)
  assert.equal(approvalsOff({ get: () => undefined }, { agent: { session } }), false)
  assert.equal(approvalsOff(ctxWith('never'), {}), false, 'без агента спрашивать некого')
})

test('a settings document with holes does not erase the defaults behind them', () => {
  assert.deepEqual(stripUndefined({ enabled: true, hostRoot: undefined }), { enabled: true })
  assert.deepEqual(stripUndefined(undefined), {})
})

test('what a host command shows is what it said', () => {
  assert.match(renderRun({ exitCode: 0, stdout: 'ok\n' }), /^ok$/)
  assert.match(renderRun({ exitCode: 1, stderr: 'boom' }), /stderr:\nboom/)
  assert.match(renderRun({ exitCode: 1, stderr: 'boom' }), /код выхода: 1/)
  assert.match(renderRun({ exitCode: 0, stdout: '' }), /пусто, код 0/)
  assert.match(renderRun({ exitCode: 137, timedOut: true }), /не уложилась в срок/)
  assert.equal(digest('  docker   ps  -a '), 'docker ps -a')
})

test('a project list reads as a list of projects', () => {
  const text = renderProjects({ projects: [{ name: 'uts', hostPath: '/opt/uts', kinds: ['git', 'python'] }], truncated: true })
  assert.match(text, /• uts — \/opt\/uts \[git, python\]/)
  assert.match(text, /обрезан/)
  assert.match(renderProjects({ projects: [] }), /не нашёл/)
})

/**
 * The rule the tool registry enforces while the plugin mounts: every object
 * node says `additionalProperties` out loud, every array declares its items.
 * Breaking it threw out of `apply`, and a plugin that throws there mounts
 * nothing at all — no tools, no settings section, and no logger to say so.
 */
function offences(schema, path = '$') {
  const found = []
  if (schema === null || typeof schema !== 'object') return found
  if (schema.type === 'object') {
    if (typeof schema.additionalProperties !== 'boolean') found.push(`${path}.additionalProperties`)
    for (const [key, value] of Object.entries(schema.properties ?? {})) {
      found.push(...offences(value, `${path}.${key}`))
    }
  }
  if (schema.type === 'array') {
    if (schema.items === undefined) found.push(`${path}.items`)
    else found.push(...offences(schema.items, `${path}[]`))
  }
  return found
}

test('every output schema is one the tool registry will accept', () => {
  for (const [name, schema] of [['host_bash', RUN_SCHEMA], ['find_projects', PROJECTS_SCHEMA], ['add_workspace', WORKSPACE_SCHEMA]]) {
    assert.deepEqual(offences(schema), [], `${name}: схема не пройдёт проверку при монтировании`)
  }
})

test('the guard itself catches the shape that broke the mount', () => {
  // The exact schema that shipped: an array of objects with nothing said about
  // their extra properties.
  assert.deepEqual(
    offences({ type: 'object', additionalProperties: true, properties: { projects: { type: 'array', items: { type: 'object' } } } }),
    ['$.projects[].additionalProperties'],
  )
})
