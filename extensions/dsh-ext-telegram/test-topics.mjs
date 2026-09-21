// Topic naming and colouring. Run inside the dsh container:
//   node --test /data/dsh/profiles/web/node_modules/dsh-ext-telegram/test-topics.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { colorFor, shortPath, topicName, topicSpec, TOPIC_COLORS, workspaceOf } from './topics.js'

const workspaces = [
  { name: 'harness', path: '/workspace/deepseek-harness' },
  { name: 'site', path: '/workspace/projects/site' },
  { path: '/workspace/projects' },
]

test('a session belongs to the workspace whose path is its longest prefix', () => {
  assert.equal(workspaceOf('/workspace/projects/site/src', workspaces).name, 'site')
  assert.equal(workspaceOf('/workspace/projects/other', workspaces).path, '/workspace/projects')
  assert.equal(workspaceOf('/workspace/deepseek-harness', workspaces).name, 'harness')
  assert.equal(workspaceOf('/tmp/elsewhere', workspaces), undefined)
  assert.equal(workspaceOf(undefined, workspaces), undefined)
  // a sibling directory that merely starts with the same letters is not inside it
  assert.equal(workspaceOf('/workspace/projects-old/x', workspaces), undefined)
})

test('a topic is named "project · subject" and stays within the limit', () => {
  assert.equal(topicName(workspaces[0], 'Fix the login bug'), 'harness · Fix the login bug')
  assert.equal(topicName(workspaces[2], 'Что-то'), 'projects · Что-то')
  assert.equal(topicName(workspaces[0], '  много   пробелов  '), 'harness · много пробелов')
  assert.equal(topicName(workspaces[0], undefined), 'harness · новая сессия')
  assert.equal(topicName(undefined, 'Без проекта'), 'Без проекта')
  assert.equal(topicName(undefined, undefined), 'dsh сессия')
  assert.equal(topicName(workspaces[0], 'z'.repeat(200)).length, 96)
})

test('colour is stable per project and drawn from the palette Telegram accepts', () => {
  const first = colorFor('/workspace/deepseek-harness')
  assert.equal(first, colorFor('/workspace/deepseek-harness'), 'the same project always looks the same')
  assert.ok(TOPIC_COLORS.includes(first))
  assert.ok(TOPIC_COLORS.includes(colorFor(undefined)))
  const used = new Set(['/a', '/b', '/c', '/d', '/e', '/f', '/g'].map(colorFor))
  assert.ok(used.size > 1, 'different projects do not all collapse to one colour')
})

test('the spec a session opens its topic with', () => {
  const spec = topicSpec({ cwd: '/workspace/projects/site/src', title: 'Вёрстка хедера' }, workspaces)
  assert.equal(spec.name, 'site · Вёрстка хедера')
  assert.equal(spec.workspace.name, 'site')
  assert.equal(spec.iconColor, colorFor('/workspace/projects/site'))
  // outside every workspace the directory still names the thread
  const loose = topicSpec({ cwd: '/tmp/scratch', title: 'проба' }, workspaces)
  assert.equal(loose.name, 'проба')
  assert.equal(loose.iconColor, colorFor('/tmp/scratch'))
  assert.equal(shortPath('/workspace/projects/site'), 'site')
  assert.equal(shortPath('/'), '')
})
