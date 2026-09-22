// Tools on demand. Run inside the dsh container:
//   node --test /data/dsh/profiles/web/node_modules/dsh-ext-toolbelt/test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_GROUPS, describeGroups, groupOf, toolsOf, unlockedText } from './groups.js'

/** Schema sizes measured on a live request header, in tokens. */
const MEASURED = {
  mcp__thinking__sequentialthinking: 1012,
  workflow: 997,
  'mcp__context7__resolve-library-id': 727,
  'mcp__context7__query-docs': 426,
  update_goal: 285,
  ralph: 207,
  job_output: 208,
  create_goal: 174,
  mcp__memory__create_relations: 162,
  mcp__memory__delete_relations: 160,
  mcp__memory__create_entities: 154,
  mcp__memory__delete_observations: 142,
  mcp__memory__add_observations: 141,
  job_kill: 114,
  mcp__memory__delete_entities: 92,
  mcp__memory__search_nodes: 87,
  mcp__memory__open_nodes: 83,
  get_goal: 80,
  mcp__memory__read_graph: 45,
  job_list: 42,
  session_search: 260,
  session_trace: 120,
  session_event_trace: 150,
}

test('the hidden groups are the ones that actually cost something', () => {
  const hidden = Object.keys(DEFAULT_GROUPS)
  const names = toolsOf(DEFAULT_GROUPS, hidden)
  const saved = names.reduce((sum, tool) => sum + (MEASURED[tool] ?? 0), 0)
  assert.equal(names.length, 23)
  assert.ok(saved > 5000, `hiding these must save real tokens, got ${saved}`)
  // every hidden name is one that was really in the request header
  for (const tool of names) assert.ok(MEASURED[tool] !== undefined, `${tool} is not a tool this deployment has`)
})

test('the everyday surface is never hidden', () => {
  const hiddenNames = new Set(toolsOf(DEFAULT_GROUPS, Object.keys(DEFAULT_GROUPS)))
  for (const tool of ['read', 'write', 'edit', 'grep', 'glob', 'bash', 'todo_write', 'subagent', 'web_search', 'generate_image', 'skill',
    // the recall pair every compaction checkpoint promises is available
    'session_event_search', 'session_event_read']) {
    assert.equal(hiddenNames.has(tool), false, `${tool} must stay loaded`)
  }
})

test('group membership is a two-way lookup', () => {
  assert.deepEqual(toolsOf(DEFAULT_GROUPS, ['docs']), ['mcp__context7__resolve-library-id', 'mcp__context7__query-docs'])
  assert.equal(groupOf(DEFAULT_GROUPS, 'session_search'), 'history')
  assert.equal(groupOf(DEFAULT_GROUPS, 'schedule_list'), undefined, 'скоуп-инструменты реестр прятать не даёт — обещать это нельзя')
  assert.equal(groupOf(DEFAULT_GROUPS, 'read'), undefined)
  assert.deepEqual(toolsOf(DEFAULT_GROUPS, ['нетакой']), [])
})

test('the description tells the model what each group is for, and stays small', () => {
  const text = describeGroups(DEFAULT_GROUPS, Object.keys(DEFAULT_GROUPS))
  for (const group of Object.keys(DEFAULT_GROUPS)) assert.match(text, new RegExp(`${group} — `))
  assert.match(text, /не занимают контекст/)
  // the whole point is that this is cheap: it must not approach what it hides
  assert.ok(text.length / 4 < 400, `description must stay small, got ~${Math.round(text.length / 4)} tokens`)
})

test('the answer after unlocking names what became available', () => {
  assert.match(unlockedText(DEFAULT_GROUPS, 'docs', ['mcp__context7__query-docs']), /документация библиотек/)
  assert.match(unlockedText(DEFAULT_GROUPS, 'docs', []), /уже была доступна/)
  assert.match(unlockedText(DEFAULT_GROUPS, 'нетакой', []), /Нет такой группы/)
})
