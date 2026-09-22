// dsh-ext-compaction-pro — a drop-in replacement for @deepseek-ai/dsh-compaction-basic.
//
// Same triggers, same durable protocol, same prefix-cache-friendly replay (all
// inherited). Only the `summarize()` hook changes:
//   1. Structured checkpoint with extra sections that Claude-Code-style
//      compaction proved essential: verbatim user directives, decisions with
//      rationale, verification state, environment facts.
//   2. A deterministic ledger (touched files, shell commands, user instructions)
//      is extracted from the span and handed to the summariser so those details
//      survive verbatim instead of being paraphrased away.
//   3. MAX_TOKENS → one retry with a tighter instruction and a bigger cap.
//   4. Span too large for one call (context overflow on the summariser itself)
//      → map-reduce: split at a user-message boundary, summarise halves
//      (recursively, bounded depth), then merge into one checkpoint.
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { BlockAssembler, contentHasImage, createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import { buildLedger, renderLedger, splitAtHumanBoundary } from './ledger.js'

const PLUGIN = 'dsh-ext-compaction-pro'
const MAX_DEPTH = 3
const RETRY_TOKEN_CAP = 32_768

export const CHECKPOINT_SECTIONS = [
  ['Primary Request and Intent', "the user's original and evolving goals; quote verbatim where wording matters"],
  ['User Directives (verbatim)', 'explicit instructions, constraints, preferences and corrections the user gave, quoted exactly'],
  ['Key Technical Concepts', 'technologies, frameworks, patterns, conventions in play'],
  ['Files and Code', 'exact path: why it matters, key changes or snippets; include every path from the ledger'],
  ['Decisions and Rationale', 'choices made, alternatives rejected, and why'],
  ['Errors and Fixes', 'error: how it was resolved, plus related user feedback'],
  ['Verification State', 'what was tested/run, exact commands, results, what is still unverified'],
  ['Environment Facts', 'hosts, ports, paths, services, credentials LOCATIONS (never values), tool quirks discovered'],
  ['Pending Jobs', 'explicitly requested work not yet completed'],
  ['Current Work', 'precisely what was in progress at this checkpoint'],
  ['Next Step', 'the single next action, directly in line with the most recent request, or "(none)"'],
  ['Open Questions', 'things awaiting the user or still unknown'],
]

const SUMMARY_OPEN_TAG = '<compacted-summary>'

export function buildInstruction(ledger, opts = {}) {
  const tight = opts.tight === true
  const sections = CHECKPOINT_SECTIONS.flatMap(([title, hint]) => [`## ${title}`, `- [${hint}]`, ''])
  return [
    'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
    '',
    `Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose. Write "(none)" for an empty section — never drop a section.${tight ? ' HARD LIMIT: be brief — at most 6 bullets per section, one line each; the previous attempt overflowed the output cap.' : ''}`,
    '',
    ...sections,
    'Rules:',
    '- Concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures and syntax fragments.',
    '- Capture user feedback and explicit instructions faithfully, especially corrections; the "User Directives" section quotes them verbatim.',
    '- Every path, command, user instruction, plan item and failure in the ledger below must appear in the checkpoint; the ledger is not a hint, it is the floor.',
    '- Do NOT mention this summarization request or that the context was compacted.',
    '- Output only the checkpoint text: do not call any tool or take any other action.',
    `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, merge newer information into one consolidated summary under the same structure.`,
    '',
    renderLedger(ledger),
  ].join('\n')
}

export function buildMergeInstruction(parts) {
  return [
    `Below are ${parts.length} partial checkpoints, each condensing a consecutive part of one long conversation (oldest first). Merge them into ONE consolidated checkpoint with exactly the same section structure as the parts.`,
    'Later parts override earlier ones where they conflict; keep every still-relevant path, command, decision and user directive; drop what later parts show to be stale.',
    'Output only the merged checkpoint text. Do not call any tool.',
    '',
    ...parts.flatMap((p, i) => [`### Part ${i + 1}`, p, '']),
  ].join('\n')
}

/**
 * The line that turns compaction from loss into paging.
 *
 * Everything this checkpoint condensed is still on disk, event by event, and
 * the session-query tools can search and read it. Saying so in the checkpoint
 * is what lets the next model stop guessing at a detail the summary dropped —
 * and what makes it safe to summarise aggressively in the first place.
 */
export function recallPointer(sessionId) {
  return [
    '---',
    `Nothing above is the whole record: the full pre-checkpoint history of this session is still stored event by event under session id \`${sessionId}\`.`,
    'When a detail you need is missing or ambiguous, do not guess and do not ask the user to repeat it:',
    `- \`session_event_search\` with that session id finds the earlier events matching a query;`,
    '- `session_event_read` returns one of them verbatim, with its neighbours.',
    'Prefer one recall call over one wrong assumption.',
  ].join('\n')
}

function summaryText(blocks) {
  if (contentHasImage(blocks)) throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
  return blocks.filter((b) => b.type === 'text')
}

function finishError(finish) {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      const e = new Error(finish.failure.message)
      e.code = finish.failure.code
      return e
    }
    case 'max-tokens': {
      const e = new Error('summarization truncated at the token cap (incomplete checkpoint)')
      e.code = 'MAX_TOKENS'
      return e
    }
    default:
      return undefined
  }
}

function addUsage(a, b) {
  if (!b) return a
  if (!a) return { ...b }
  const out = { ...a }
  for (const k of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    if (b[k] !== undefined) out[k] = (out[k] ?? 0) + b[k]
  }
  return out
}

/** Route selection: configured summariser → last routed request → agent defaults. */
export function resolveTarget(config, agent) {
  const configured = config.summarizationProvider && config.summarizationProvider.length > 0
    ? { provider: config.summarizationProvider, model: config.summarizationModel }
    : undefined
  const latest = agent.session.requestHeader?.()?.config
  const agentTarget = agent.options?.provider && agent.options?.model
    ? { provider: agent.options.provider, model: agent.options.model }
    : undefined
  const target = configured ?? latest ?? agentTarget
  if (target === undefined) throw new Error('no provider/model available for summarization')
  return target
}

/**
 * Our defaults, under whatever the composition sets.
 *
 * Compaction rewrites the head of the conversation, so it invalidates the
 * provider's prefix cache for everything that follows. On DeepSeek a cache hit
 * costs a thirtieth of a miss, which makes ONE deep compaction far cheaper than
 * two shallow ones: compact later (0.85 of the window rather than 0.80), keep a
 * longer verbatim tail (0.20), and give the checkpoint room to be complete —
 * twelve sections do not fit in 8k.
 */
export const PRO_DEFAULTS = {
  thresholdRatio: 0.85,
  retainRatio: 0.2,
  maxTokens: 16_384,
}

export default class ProCompactionEngine extends BasicCompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions']
  static Config = BasicCompactionEngine.Config

  constructor(ctx, config = {}) {
    // The base schema leaves these keys absent when a row does not set them,
    // so a spread underneath is a real default rather than an override of the
    // operator's choice.
    super(ctx, { ...PRO_DEFAULTS, ...config })
  }

  /** One `ctx.llm.stream()` call: replayed prefix + final instruction message. */
  async _callSummarizer(target, messages, tools, instruction, maxTokens, agent, signal) {
    const assembler = new BlockAssembler()
    const options = {
      provider: target.provider,
      model: target.model,
      messages: [
        ...messages,
        createUserMessage({ content: [{ type: 'text', text: instruction }], source: { kind: 'plugin', plugin: PLUGIN } }),
      ],
      ...(tools === undefined ? {} : { tools: [...tools] }),
      maxTokens,
      sessionId: agent.session.id,
      purpose: 'compaction',
      ...(signal === undefined ? {} : { signal }),
    }
    for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk)
    const error = finishError(assembler.finish)
    if (error !== undefined) throw error
    const rawOutput = assembler.blocks()
    const summary = summaryText(rawOutput)
    if (!summary.some((b) => b.text.trim().length > 0)) throw new Error('summarization produced no text summary content')
    return { summary, rawOutput, usage: assembler.usage }
  }

  /** Summarise one span; retries once on MAX_TOKENS; map-reduces on overflow. */
  async _summarizeSpan(target, systemHead, span, tools, agent, signal, depth) {
    const ledger = buildLedger(span)
    const maxTokens = this.config.maxTokens
    try {
      return await this._callSummarizer(target, [...systemHead, ...span], tools, buildInstruction(ledger), maxTokens, agent, signal)
    } catch (error) {
      const code = error?.code
      if (code === 'MAX_TOKENS') {
        this.ctx.logger?.warn?.(`${PLUGIN}: summary hit the token cap, retrying tighter`)
        return await this._callSummarizer(
          target, [...systemHead, ...span], tools, buildInstruction(ledger, { tight: true }),
          Math.min(Math.max(maxTokens * 2, 4096), RETRY_TOKEN_CAP), agent, signal,
        )
      }
      if (code === 'CONTEXT_WINDOW_EXCEEDED' && depth < MAX_DEPTH) {
        const halves = splitAtHumanBoundary(span)
        if (halves !== undefined) {
          this.ctx.logger?.warn?.(`${PLUGIN}: span too large for one call, map-reducing (${span.length} → ${halves[0].length}+${halves[1].length} messages, depth ${depth + 1})`)
          const parts = []
          let usage
          for (const half of halves) {
            const r = await this._summarizeSpan(target, systemHead, half, tools, agent, signal, depth + 1)
            parts.push(r.summary.map((b) => b.text).join('\n'))
            usage = addUsage(usage, r.usage)
          }
          const merged = await this._callSummarizer(target, systemHead, undefined, buildMergeInstruction(parts), Math.min(maxTokens * 2, RETRY_TOKEN_CAP), agent, signal)
          return { ...merged, usage: addUsage(usage, merged.usage), merged: true }
        }
      }
      throw error
    }
  }

  /**
   * Whether this deployment can page its own history back in. The pointer we
   * append to a checkpoint is a PROMISE to the next model: if the tools are not
   * mounted, the promise is a lie that costs a wasted tool call, so it is made
   * only when the registry really holds them.
   */
  _canRecall() {
    const tools = this.ctx.get?.('tools')
    if (tools?.get === undefined) return false
    try {
      return tools.get('session_event_search') !== undefined && tools.get('session_event_read') !== undefined
    } catch {
      return false
    }
  }

  async summarize(input, agent, signal) {
    const target = resolveTarget(this.config, agent)
    const messages = input.messages
    const systemHead = messages.length > 0 && messages[0].role === 'system' ? [messages[0]] : []
    const span = messages.slice(systemHead.length)
    const r = await this._summarizeSpan(target, systemHead, span, input.tools, agent, signal, 0)
    const pointer = this._canRecall() ? recallPointer(agent.session.id) : undefined
    return {
      summary: pointer === undefined ? r.summary : [...r.summary, { type: 'text', text: pointer }],
      rawOutput: r.rawOutput,
      ...(r.merged ? {} : { llmStreamCall: true }),
      provider: target.provider,
      model: target.model,
      maxTokens: this.config.maxTokens,
      ...(r.usage === undefined ? {} : { usage: r.usage }),
    }
  }
}
