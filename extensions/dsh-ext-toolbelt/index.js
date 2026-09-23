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
import { DEFAULT_GROUPS, DELEGATES, delegateText, describeGroups, toolsOf, unlockedText } from './groups.js'

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
    if (agentCtx?.tools?.restrict === undefined) return []
    let held = restricted.get(agent)
    if (held === undefined) {
      held = new Map()
      restricted.set(agent, held)
    }
    const missed = []
    for (const tool of names) {
      if (held.has(tool)) continue
      try {
        held.set(tool, agentCtx.tools.restrict({ deny: [tool] }))
      } catch (error) {
        // `restrict()` refuses a name that is not registered YET, and refuses a
        // scoped registration by design. The first case is a race worth
        // retrying; the second is permanent. Either way the name stays visible
        // and paid for, so it is reported rather than swallowed.
        missed.push(tool)
        lastRefusal = `${tool}: ${error?.message ?? error}`
      }
    }
    return missed
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

  /** The last name the registry refused to hide, surfaced by `enable_tools`. */
  let lastRefusal

  ctx.on('agent/created', ({ agent }) => {
    if (hidden.length === 0) return
    const missed = hideFor(agent, toolsOf(groups, hidden))
    if (missed.length === 0) return
    // A tool registered after the agent was created cannot be restricted at
    // creation time. One retry when the agent actually starts working catches
    // exactly that case, and costs nothing when there is nothing to catch.
    const retry = () => {
      const still = hideFor(agent, missed)
      if (still.length > 0) {
        process.stderr.write(`ext-toolbelt: still visible after retry: ${still.join(', ')} (${lastRefusal ?? 'no reason reported'})\n`)
      }
    }
    const dispose = ctx.on('agent/status', (event) => {
      if (event?.agent !== agent || event?.status !== 'running') return
      dispose()
      retry()
    })
  })

  // What each delegate is for. Registered only for the ones the registry really
  // holds, and computed from registry membership — which does not change inside
  // a session, so the text stays stable and the prefix cache survives.
  ctx.inject(['systemPrompt'], (sctx) => {
    sctx.effect(() => sctx.systemPrompt.section({
      name: 'toolbelt:delegates',
      order: sctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT') - 1,
      text: (context) => {
        const registry = sctx.get?.('tools')
        if (registry?.get === undefined) return ''
        const present = Object.keys(DELEGATES).filter((name) => {
          try {
            return registry.get(name, context?.scope) !== undefined
          } catch {
            return false
          }
        })
        return delegateText(present)
      },
    }), 'ext-toolbelt: delegate guidance')
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
