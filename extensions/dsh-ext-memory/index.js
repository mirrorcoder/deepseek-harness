// dsh-ext-memory — what the harness knows before the conversation starts.
//
// Compaction keeps a session alive; this keeps knowledge alive between them.
// Notes live on disk under $DSH_HOME/memory, one directory per workspace plus a
// global one, and are loaded into the system prompt at the start of every
// session in that workspace. `remember` writes one, `forget` removes one.
//
// THE CACHE RULE: the system prompt is the head of every request, so any text
// that changes inside a conversation invalidates the provider's prefix cache
// for the whole of it — on DeepSeek a cache hit costs a thirtieth of a miss.
// The notes are therefore SNAPSHOTTED per session: a note written now takes
// effect in the next session, and the tool says so instead of silently
// rewriting the head of the current one. (The writing agent has the text in
// front of it anyway; it is the only one that does not need to re-read it.)
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { fileNameOf, listNotes, nameOf, renderNotes, slugOf } from './notes.js'

export const name = 'ext-memory'
export const inject = ['tools', 'systemPrompt']

export const Config = z.object({
  enabled: z.boolean().default(true),
  /** Where notes live; one directory per workspace, plus `global`. */
  dir: z.string().default(''),
  /** Upper bound on what the prompt section may cost, in characters. */
  maxChars: z.number().default(6000),
})

const GLOBAL = 'global'

export function apply(ctx, config) {
  if (config.enabled === false) return
  const root = config.dir && config.dir.length > 0
    ? config.dir
    : join(process.env.DSH_HOME ?? '/data/dsh', 'memory')

  const dirFor = (scope, cwd) => join(root, scope === GLOBAL ? GLOBAL : slugOf(cwd))

  /** Every note of one directory, with its mtime for ordering. */
  const readDir = async (dir) => {
    let files
    try {
      files = await readdir(dir)
    } catch {
      return []
    }
    const notes = []
    for (const file of files) {
      if (!file.endsWith('.md')) continue
      try {
        const body = await readFile(join(dir, file), 'utf8')
        const info = await stat(join(dir, file))
        notes.push({ name: file, body, changedAt: info.mtimeMs, dir })
      } catch {
        // a note that vanished between listing and reading is not an error
      }
    }
    return notes
  }

  const notesFor = async (cwd) => [...await readDir(dirFor(GLOBAL, cwd)), ...await readDir(dirFor('project', cwd))]

  /** Every note of one directory, read synchronously for prompt assembly. */
  const readDirSync = (dir) => {
    let files
    try {
      files = readdirSync(dir)
    } catch {
      return []
    }
    const notes = []
    for (const file of files) {
      if (!file.endsWith('.md')) continue
      try {
        notes.push({ name: file, body: readFileSync(join(dir, file), 'utf8'), changedAt: statSync(join(dir, file)).mtimeMs })
      } catch {
        // a note that vanished between listing and reading is not an error
      }
    }
    return notes
  }

  /**
   * One snapshot per session, taken at the FIRST prompt assembly and never
   * recomputed. Synchronous on purpose: a handful of small files costs
   * milliseconds once, while an async load would leave the first request
   * without the section and then change the head of the conversation on the
   * second — the exact cache invalidation this file exists to avoid.
   */
  const snapshots = new Map()
  const snapshotFor = (context) => {
    const session = context?.agent?.session
    const key = session?.id ?? 'no-session'
    const held = snapshots.get(key)
    if (held !== undefined) return held
    const cwd = session?.header?.cwd ?? session?.cwd ?? process.cwd()
    let text = ''
    try {
      text = renderNotes([...readDirSync(dirFor(GLOBAL, cwd)), ...readDirSync(dirFor('project', cwd))], { maxChars: config.maxChars })
    } catch {
      // Memory that cannot be read must never stop a session from starting.
    }
    snapshots.set(key, text)
    // A long-lived host must not accumulate one entry per session forever.
    if (snapshots.size > 500) snapshots.delete(snapshots.keys().next().value)
    return text
  }

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'memory:notes',
    // After the persona and the policies, before the tool instructions: this is
    // background the agent should read as established, not as an instruction.
    order: ctx.systemPrompt.getSectionOrder('PLAN_POLICY') - 1,
    text: (context) => snapshotFor(context),
  }), 'ext-memory: prompt section')

  const write = async (scope, cwd, noteName, text) => {
    const dir = dirFor(scope, cwd)
    await mkdir(dir, { recursive: true })
    const file = fileNameOf(noteName)
    await writeFile(join(dir, file), `${String(text).trim()}\n`, 'utf8')
    return { file, dir }
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'remember',
    description: [
      'Save one durable fact about this project or machine so every FUTURE session starts knowing it.',
      'Use it for what was learned the hard way and is not in the code: where something is deployed, the command that really works, a decision the user made and why, a trap that cost time.',
      'Do NOT use it for what the repository already says, for secrets, or for things that matter only inside this conversation.',
      'Re-using a name overwrites that note — that is how a fact gets corrected.',
      'Notes are loaded at session start, so a new note is visible from the next session onward; you already have this one in front of you.',
    ].join(' '),
    parameters: {
      name: { type: 'string', required: true, description: 'Short kebab-case id of the fact, e.g. "deploy-command" or "prod-host". Re-using one overwrites it.' },
      text: { type: 'string', required: true, description: 'The fact itself, in a few lines. Include the why when it is not obvious.' },
      scope: { type: 'string', description: '"project" (default) stores it for this workspace; "global" for every workspace on this machine.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { name: { type: 'string' }, scope: { type: 'string' }, path: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: `Запомнил «${value.name}» (${value.scope}). Появится в системном промпте со следующей сессии.` }],
    },
    presentCall: (args) => ({ card: 'generic', title: `Запомнить: ${args.name}`, kind: 'other', rawInput: args }),
    async execute(args, exec) {
      const scope = args.scope === GLOBAL ? GLOBAL : 'project'
      const cwd = exec?.agent?.session?.header?.cwd ?? exec?.agent?.session?.cwd ?? process.cwd()
      const { file, dir } = await write(scope, cwd, args.name, args.text)
      return { name: nameOf(file), scope, path: join(dir, file) }
    },
  })), 'ext-memory: remember')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'forget',
    description: 'Delete one stored memory note by name, or list what is stored when called without a name. Use it when a remembered fact turns out to be wrong or has expired.',
    parameters: {
      name: { type: 'string', description: 'The note to delete. Omit to list what is stored.' },
      scope: { type: 'string', description: '"project" (default) or "global".' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    presentCall: (args) => ({ card: 'generic', title: args.name ? `Забыть: ${args.name}` : 'Что в памяти', kind: 'other', rawInput: args }),
    async execute(args, exec) {
      const scope = args.scope === GLOBAL ? GLOBAL : 'project'
      const cwd = exec?.agent?.session?.header?.cwd ?? exec?.agent?.session?.cwd ?? process.cwd()
      if (args.name === undefined || String(args.name).trim().length === 0) {
        return { text: listNotes(await notesFor(cwd)) }
      }
      const dir = dirFor(scope, cwd)
      const file = fileNameOf(args.name)
      try {
        await rm(join(dir, file))
      } catch {
        return { text: `Заметки «${nameOf(file)}» в памяти нет.` }
      }
      return { text: `Забыл «${nameOf(file)}». Из системного промпта пропадёт со следующей сессии.` }
    },
  })), 'ext-memory: forget')
}
