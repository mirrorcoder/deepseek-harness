// dsh-ext-toolbelt — tools on demand instead of tools in every request.
//
// Every tool's JSON schema rides in the head of every request. Measured on this
// deployment: 43 tools = 10.8k tokens, of which 5.8k belong to tools used a few
// times a week (sequential thinking, library docs, the memory graph, workflows,
// schedule, goals, jobs). That is paid on every single step of every session.
//
// So those groups start hidden — the registry's restriction seam removes them
// from the schema list, which is exactly what is sent to the model — and one
// small tool lets the agent unlock a group the moment a task needs it. The
// unlock lasts for that session; other sessions keep the lean surface.
//
// Cost of the mechanism: ~150 tokens for `enable_tools`. Saving: ~5.8k per
// request until something actually needs the heavy surface.
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DEFAULT_GROUPS, describeGroups, toolsOf, unlockedText } from './groups.js'

export const name = 'ext-toolbelt'
export const inject = ['tools']

const Group = z.object({
  title: z.string().default(''),
  why: z.string().default(''),
  tools: z.array(z.string()).default([]),
})

export const Config = z.object({
  /** Groups that start hidden; anything not listed here is always loaded. */
  hidden: z.array(z.string()).default(Object.keys(DEFAULT_GROUPS)),
  /** Group definitions; override to move a tool in or out. */
  groups: z.dict(Group).default(DEFAULT_GROUPS),
  /** The tool the model calls to unlock a group. */
  toolName: z.string().default('enable_tools'),
})

export function apply(ctx, config) {
  const groups = Object.keys(config.groups ?? {}).length > 0 ? config.groups : DEFAULT_GROUPS
  const hidden = (config.hidden ?? []).filter((name) => groups[name] !== undefined)

  /** agent → Map<toolName, disposer> for the restrictions currently in force. */
  const restricted = new WeakMap()

  /**
   * Hide a group's tools from one agent. Restriction is per name on purpose:
   * a tool the preset owns rather than inherits is not restrictable, and one
   * unrestrictable name must not cost the whole group its saving.
   */
  const hideFor = (agent, names) => {
    const agentCtx = agent?.ctx
    if (agentCtx?.tools?.restrict === undefined) return
    let held = restricted.get(agent)
    if (held === undefined) {
      held = new Map()
      restricted.set(agent, held)
    }
    for (const tool of names) {
      if (held.has(tool)) continue
      try {
        held.set(tool, agentCtx.tools.restrict({ deny: [tool] }))
      } catch {
        // Not a restrictable name in this composition: leave it visible.
      }
    }
  }

  const revealFor = (agent, names) => {
    const held = restricted.get(agent)
    if (held === undefined) return []
    const lifted = []
    for (const tool of names) {
      const dispose = held.get(tool)
      if (dispose === undefined) continue
      try {
        dispose()
        held.delete(tool)
        lifted.push(tool)
      } catch {
        // A disposer that already ran is not a failure worth reporting.
      }
    }
    return lifted
  }

  ctx.on('agent/created', ({ agent }) => {
    if (hidden.length === 0) return
    hideFor(agent, toolsOf(groups, hidden))
  })

  ctx.effect(() => ctx.tools.register(defineTool({
    name: config.toolName,
    description: describeGroups(groups, hidden),
    parameters: {
      group: {
        type: 'string',
        required: true,
        description: `Какую группу подключить: ${hidden.join(', ')}.`,
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { enabled: { type: 'array', items: { type: 'string' } }, text: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    presentCall: (args) => ({ card: 'generic', title: `Подключить: ${args.group}`, kind: 'other', rawInput: args }),
    execute(args, exec) {
      const wanted = String(args.group ?? '').trim()
      if (groups[wanted] === undefined) {
        return Promise.resolve({ enabled: [], text: `Нет такой группы: ${wanted}. Доступны: ${hidden.join(', ')}.` })
      }
      const lifted = revealFor(exec.agent, toolsOf(groups, [wanted]))
      return Promise.resolve({ enabled: lifted, text: unlockedText(groups, wanted, lifted) })
    },
  })))
}
