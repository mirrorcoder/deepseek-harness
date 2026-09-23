// Which tools are worth their place in every request, and which are not.
//
// A tool's JSON schema travels in the head of EVERY request: 43 tools cost
// about 10.8k tokens before a word of conversation. Most of them are used a
// few times a week. This splits them into named groups that start hidden and
// are unlocked by the model itself when a task needs them — one 150-token tool
// in place of five thousand.
//
// Pure data and pure functions; the extension applies them.

/** Measured on a live request header, in tokens (JSON length / 4). */
export const DEFAULT_GROUPS = {
  think: {
    title: 'пошаговое рассуждение',
    why: 'структурированное размышление над сложной задачей',
    tools: ['mcp__thinking__sequentialthinking'],
  },
  docs: {
    title: 'документация библиотек',
    why: 'свежие доки по конкретной библиотеке или фреймворку',
    tools: ['mcp__context7__resolve-library-id', 'mcp__context7__query-docs'],
  },
  memory: {
    title: 'долгая память',
    why: 'граф сущностей и связей + удаление сохранённых заметок (сами заметки уже в системном промпте, а `remember` всегда под рукой)',
    tools: [
      'forget',
      'mcp__memory__create_entities', 'mcp__memory__create_relations', 'mcp__memory__add_observations',
      'mcp__memory__delete_entities', 'mcp__memory__delete_relations', 'mcp__memory__delete_observations',
      'mcp__memory__read_graph', 'mcp__memory__search_nodes', 'mcp__memory__open_nodes',
    ],
  },
  workflow: {
    title: 'многошаговые прогоны',
    why: 'параллельные подзадачи и циклы доводки (workflow, ralph)',
    tools: ['workflow', 'ralph'],
  },
  // NOTE: schedule_create / schedule_list / schedule_delete are NOT here, and
  // cannot be. `tools.restrict()` masks GLOBAL registrations only; the schedule
  // plugin registers per session scope, and the registry answers "unknown
  // global tool" for those names. Listing them here cost nothing and promised
  // a saving that never happened — 459 tokens that look hidden and are not.
  // (This was invisible until the extension started reporting refusals.)
  goals: {
    title: 'цели',
    why: 'вести формальную цель сессии',
    tools: ['create_goal', 'update_goal', 'get_goal'],
  },
  jobs: {
    title: 'фоновые задачи',
    why: 'смотреть и прерывать фоновые запуски',
    tools: ['job_list', 'job_output', 'job_kill'],
  },
  // NOTE: `session_event_search` and `session_event_read` are deliberately NOT
  // here. Every compaction checkpoint tells the model those two exist and to
  // reach for them instead of guessing; a recall path that must first be
  // unlocked is a recall path that will not be used at the moment it matters.
  // The three below are the cross-session and lineage half, which is rare.
  history: {
    title: 'поиск по прошлым сессиям',
    why: 'найти работу в ДРУГИХ сессиях и разобрать связи событий (родословная, замены)',
    tools: ['session_search', 'session_trace', 'session_event_trace'],
  },
}

/** Every tool name the given groups cover. */
export function toolsOf(groups, names) {
  const out = []
  for (const name of names) {
    for (const tool of groups[name]?.tools ?? []) out.push(tool)
  }
  return out
}

/** The group a tool belongs to, or undefined. */
export function groupOf(groups, tool) {
  for (const [name, group] of Object.entries(groups)) {
    if (group.tools.includes(tool)) return name
  }
  return undefined
}

/**
 * The description the model reads. It has to carry enough for the model to
 * know when to reach for a group without the schemas themselves being present.
 */
export function describeGroups(groups, hidden) {
  const lines = hidden.map((name) => {
    const group = groups[name]
    return group === undefined ? undefined : `${name} — ${group.title}: ${group.why}`
  }).filter((line) => line !== undefined)
  return [
    'Подключить группу инструментов, которая сейчас не загружена.',
    'Их схемы не занимают контекст, пока не понадобятся; после подключения они доступны до конца сессии.',
    '',
    'Группы:',
    ...lines,
    '',
    'Вызывай ровно тогда, когда задача требует такой инструмент, и не «на всякий случай».',
  ].join('\n')
}

/** What to answer after unlocking. */
export function unlockedText(groups, name, applied) {
  const group = groups[name]
  if (group === undefined) return `Нет такой группы: ${name}.`
  if (applied.length === 0) return `Группа ${name} уже была доступна.`
  return [
    `Подключено: ${group.title} (${applied.join(', ')}).`,
    'Инструменты появятся в следующем шаге — вызывай их обычным образом.',
  ].join(' ')
}

/**
 * The specialised delegates, and what each is actually for.
 *
 * Upstream gives every `tool-subagent` instance the SAME generic description
 * ("delegate a self-contained task…"), so a deployment that mounts three of
 * them advertises three identical tools. The model cannot tell which one
 * searches — and measured on a live task it simply did not use them: twelve
 * inline grep/read/bash calls, all of it landing in the parent's context.
 * These lines are the missing half of the contract.
 */
export const DELEGATES = {
  explore: 'searching and reading: where something lives, how it works, which files are involved. It answers with a conclusion plus file:line evidence and cannot edit or run commands. Reach for it INSTEAD of a run of grep/read calls whenever the answer needs more than two or three files — what it reads never enters this conversation.',
  review: 'checking a change or a file for correctness before you hand it over. It may run tests. It answers with findings, each naming file:line and the concrete failure, or with "nothing wrong found".',
}

/** The prompt line for the delegates this deployment really has. */
export function delegateText(present) {
  const rows = Object.entries(DELEGATES).filter(([name]) => present.includes(name))
  if (rows.length === 0) return ''
  return [
    'Specialised delegates (each runs in its own context and returns only its result; give it a complete, standalone task — it does not see this conversation):',
    ...rows.map(([name, why]) => `- \`${name}\` — ${why}`),
  ].join('\n')
}
