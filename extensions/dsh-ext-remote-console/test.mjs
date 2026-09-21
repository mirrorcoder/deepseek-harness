// Run inside the dsh container:
//   node --test /data/dsh/profiles/web/node_modules/dsh-ext-remote-console/test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, consoleInjection, TRANSPORT_GLOBAL } from './index.js'

function fakeCtx() {
  const listeners = new Map()
  return {
    listeners,
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    emitIndex() {
      const table = []
      listeners.get('webserver/index-inject')?.(table)
      return table
    },
  }
}

test('the row assigns the page global the client reads', () => {
  const row = consoleInjection()
  assert.equal(row.kind, 'global')
  assert.equal(row.name, TRANSPORT_GLOBAL)
  assert.deepEqual(row.value, { ownsHost: true })
})

test('no transport hooks are declared, so the page keeps the ordinary carrier', () => {
  assert.deepEqual(Object.keys(consoleInjection().value), ['ownsHost'])
})

test('enabled: a row is contributed on every index render', () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: true })
  assert.deepEqual(ctx.emitIndex(), [consoleInjection()])
  const first = ctx.emitIndex()[0]
  const second = ctx.emitIndex()[0]
  assert.deepEqual(first, second)
  assert.notEqual(first, second, 'each render gets its own row object')
})

test('disabled is the default and registers nothing at all', () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: false })
  assert.equal(ctx.listeners.size, 0)
  assert.deepEqual(ctx.emitIndex(), [])
})
