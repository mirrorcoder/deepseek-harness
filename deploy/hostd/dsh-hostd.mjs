#!/usr/bin/env node
// dsh-hostd — the host half of host access.
//
// The harness runs in a container: its shell, its docker, its view of the disk
// all stop at the container boundary. This daemon runs ON the host and lends
// that boundary out through one unix socket, which is bind-mounted into the
// container. The agent asks it to run a command; it runs it on the host, as
// root, and hands back stdout, stderr and the exit code.
//
// The socket is the whole security boundary — anything that can write to it can
// run anything on this machine. That is why it lives in a directory only root
// and the container's user can reach, why the service ships disabled, and why
// every call is written to an audit log before it runs.
//
// Wire protocol: one JSON request per connection, terminated by a newline, one
// JSON response, then close. JSON escapes newlines inside strings, so a bare
// newline is an unambiguous frame terminator.
//
//   → {"op":"exec","command":"docker ps","cwd":"/root","timeoutMs":120000}
//   ← {"ok":true,"exitCode":0,"stdout":"…","stderr":"","durationMs":214}
//
// Run by systemd (deploy/hostd/dsh-hostd.service); switched on and off with
// deploy/host-access.sh.
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { appendFile, chmod, mkdir, stat, unlink } from 'node:fs/promises'
import { chownSync } from 'node:fs'
import { dirname } from 'node:path'
import { hostname } from 'node:os'

const SOCKET = process.env.DSH_HOSTD_SOCKET ?? '/root/dsh-data/run-host/hostd.sock'
/** Uid the socket is handed to: the container's `node` user, uid 1000. */
const SOCKET_UID = Number(process.env.DSH_HOSTD_UID ?? 1000)
const SOCKET_GID = Number(process.env.DSH_HOSTD_GID ?? 1000)
const AUDIT = process.env.DSH_HOSTD_AUDIT ?? '/var/log/dsh-hostd.log'
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 900_000
/** Per-stream cap. A command that prints more is truncated, not killed. */
const MAX_OUTPUT = 200_000
const MAX_REQUEST = 1_000_000

/** Append one line to the audit log; a log that cannot be written must not stop the work. */
async function audit(entry) {
  try {
    await appendFile(AUDIT, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
  } catch {
    // nothing to do: the daemon's job is not logging
  }
}

function clamp(text) {
  if (text.length <= MAX_OUTPUT) return { text, truncated: false }
  return { text: `${text.slice(0, MAX_OUTPUT)}\n…(обрезано, всего ${text.length} символов)`, truncated: true }
}

/** Run one command on this machine and collect everything it said. */
function runCommand(request) {
  const command = String(request.command ?? '')
  const cwd = typeof request.cwd === 'string' && request.cwd.length > 0 ? request.cwd : '/'
  const timeoutMs = Math.min(
    Math.max(Number(request.timeoutMs ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS, 1000),
    MAX_TIMEOUT_MS,
  )
  return new Promise((resolve) => {
    const started = Date.now()
    let child
    try {
      child = spawn('/bin/bash', ['-lc', command], {
        cwd,
        env: { ...process.env, ...(request.env ?? {}), DSH_HOST_EXEC: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own process group, so a deadline can end the whole tree rather
        // than the shell alone: a backgrounded child would otherwise keep the
        // pipes open and the call would outlive its timeout.
        detached: true,
      })
    } catch (error) {
      resolve({ ok: false, error: `не удалось запустить команду: ${error.message}` })
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT * 2) stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT * 2) stderr += chunk
    })
    const timer = setTimeout(() => {
      timedOut = true
      // The whole process group: a shell that spawned children must not leave
      // them holding the pipes open.
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, error: error.message })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const out = clamp(stdout)
      const err = clamp(stderr)
      resolve({
        ok: true,
        exitCode: code ?? (signal === undefined ? 1 : 137),
        signal: signal ?? undefined,
        timedOut,
        truncated: out.truncated || err.truncated,
        stdout: out.text,
        stderr: err.text,
        cwd,
        durationMs: Date.now() - started,
      })
    })
  })
}

async function handle(request) {
  switch (request.op) {
    case 'ping':
      return { ok: true, host: hostname(), pid: process.pid, uptimeSeconds: Math.round(process.uptime()) }
    case 'exec': {
      if (typeof request.command !== 'string' || request.command.trim().length === 0) {
        return { ok: false, error: 'команда пустая' }
      }
      const result = await runCommand(request)
      await audit({
        op: 'exec',
        cwd: result.cwd ?? request.cwd,
        command: request.command,
        exitCode: result.exitCode,
        timedOut: result.timedOut === true,
        durationMs: result.durationMs,
      })
      return result
    }
    default:
      return { ok: false, error: `неизвестная операция: ${String(request.op)}` }
  }
}

async function main() {
  await mkdir(dirname(SOCKET), { recursive: true, mode: 0o750 })
  // A socket left behind by a crash would make bind() fail; a live one means a
  // second daemon, which must not happen quietly.
  try {
    await stat(SOCKET)
    await unlink(SOCKET)
  } catch {
    // no stale socket: the normal case
  }

  const server = createServer((socket) => {
    let buffer = ''
    let done = false
    const reply = (payload) => {
      if (done) return
      done = true
      socket.end(`${JSON.stringify(payload)}\n`)
    }
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      buffer += chunk
      if (buffer.length > MAX_REQUEST) {
        reply({ ok: false, error: 'запрос слишком большой' })
        return
      }
      const at = buffer.indexOf('\n')
      if (at === -1) return
      const line = buffer.slice(0, at)
      buffer = ''
      let request
      try {
        request = JSON.parse(line)
      } catch (error) {
        reply({ ok: false, error: `не разобрал запрос: ${error.message}` })
        return
      }
      handle(request).then(reply, (error) => reply({ ok: false, error: error.message }))
    })
    socket.on('error', () => {})
  })

  server.listen(SOCKET, async () => {
    // Only root (the daemon) and the container's user may speak here.
    try {
      chownSync(SOCKET, SOCKET_UID, SOCKET_GID)
    } catch {
      // a uid that does not exist on this host: the mode below still applies
    }
    await chmod(SOCKET, 0o660).catch(() => {})
    await audit({ op: 'start', socket: SOCKET, host: hostname() })
    process.stdout.write(`dsh-hostd listening on ${SOCKET}\n`)
  })

  const stop = async () => {
    await audit({ op: 'stop' })
    server.close()
    await unlink(SOCKET).catch(() => {})
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

main().catch((error) => {
  process.stderr.write(`dsh-hostd failed: ${error.stack ?? error.message}\n`)
  process.exit(1)
})
