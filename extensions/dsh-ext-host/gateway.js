// Client for the host-side gateway (deploy/hostd/dsh-hostd.mjs).
//
// One JSON request per connection, newline-terminated, one JSON answer, close.
// The connection factory is injected so the protocol is testable without a
// socket, and the failure a missing gateway produces is translated into the one
// sentence that actually helps: how to switch it on.
import { createConnection } from 'node:net'

/** Turn a connection failure into something an operator can act on. */
export function explain(error, socketPath) {
  const code = error?.code
  if (code === 'ENOENT') {
    return `шлюз доступа к хосту не запущен (нет сокета ${socketPath}). Включи его на хосте: deploy/host-access.sh on`
  }
  if (code === 'EACCES') {
    return `нет прав на сокет ${socketPath}: он должен принадлежать пользователю контейнера (uid 1000)`
  }
  if (code === 'ECONNREFUSED') {
    return `сокет ${socketPath} есть, но его никто не слушает — перезапусти сервис: systemctl restart dsh-hostd`
  }
  return error?.message ?? String(error)
}

/**
 * Ask the host gateway one thing.
 * @returns the gateway's answer; rejects with an explained error.
 */
export function askHost(socketPath, payload, options = {}) {
  const connect = options.connect ?? createConnection
  const timeoutMs = options.timeoutMs ?? 130_000
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.destroy()
      } catch {
        // already gone
      }
      if (error === undefined) resolve(value)
      else reject(error)
    }
    const timer = setTimeout(() => {
      finish(new Error(`хост не ответил за ${Math.round(timeoutMs / 1000)} с`))
    }, timeoutMs)
    let socket
    try {
      socket = connect(socketPath)
    } catch (error) {
      finish(new Error(explain(error, socketPath)))
      return
    }
    let buffer = ''
    socket.setEncoding?.('utf8')
    socket.on('error', (error) => finish(new Error(explain(error, socketPath))))
    socket.on('data', (chunk) => {
      buffer += chunk
      const at = buffer.indexOf('\n')
      if (at === -1) return
      try {
        finish(undefined, JSON.parse(buffer.slice(0, at)))
      } catch (error) {
        finish(new Error(`не разобрал ответ хоста: ${error.message}`))
      }
    })
    socket.on('close', () => {
      if (buffer.trim().length === 0) {
        finish(new Error('хост закрыл соединение, ничего не ответив'))
        return
      }
      try {
        finish(undefined, JSON.parse(buffer))
      } catch (error) {
        finish(new Error(`не разобрал ответ хоста: ${error.message}`))
      }
    })
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(payload)}\n`)
    })
  })
}

/** One line of what a command did, for the status line and the log. */
export function digest(command, max = 80) {
  return String(command ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}
