// dsh-ext-efficiency — spend fewer tokens on the same work, and show where they went.
//
// Three parts, all host-plane:
//
// 1. DEDUP. A coding agent re-reads the same file constantly. Every repeat
//    costs the full text again on every subsequent request until a checkpoint
//    condenses it. This listens on the tool pipeline, remembers what each
//    distinct call (tool + exact arguments) returned, and replaces a
//    byte-identical repeat with a one-line pointer. A call whose output
//    changed never matches its own hash and is always delivered in full.
//
// 2. PREFIX-CACHE ACCOUNTING. DeepSeek prices a cached input token at roughly
//    a thirtieth of a fresh one, so the cache-hit ratio is the number that
//    decides the bill. Usage chunks carry it; this keeps the running totals.
//
// 3. /context. Window occupancy, distance to the compaction threshold, the
//    route, cache-hit ratio and what dedup saved — the numbers the composer's
//    ring only hints at, in one place.
import z from '@deepseek-ai/schemastery'
import { DedupStore, eligible, pointerText, resultText, worthReplacing } from './dedup.js'
import { contextReport } from './report.js'

export const name = 'ext-efficiency'
export const inject = ['tools']

export const Config = z.object({
  /** Replace byte-identical repeats of the same call with a pointer. */
  dedup: z.boolean().default(true),
  /** Results shorter than this are never worth replacing. */
  minChars: z.number().default(1500),
  /** Preview characters carried by the pointer, so the model can still recognise the content. */
  previewChars: z.number().default(160),
  /** Replace only when the pointer is at least this many characters smaller. */
  minSavingChars: z.number().default(400),
  /** Distinct calls remembered per session before the oldest are forgotten. */
  maxEntries: z.number().default(256),
  /** Only these tools (empty = all). */
  includeTools: z.array(z.string()).default([]),
  /** Never these tools: anything whose repeat is meaningful in itself. */
  excludeTools: z.array(z.string()).default(['ask_user_question', 'todo_write', 'exit_plan_mode']),
  /** Compaction threshold of the active preset, for the /context bar. */
  compactionThreshold: z.number().default(0.8),
})

/** Per-session dedup memory; sessions are weakly held so nothing leaks. */
function storeFor(stores, session, maxEntries) {
  let store = stores.get(session)
  if (store === undefined) {
    store = new DedupStore(maxEntries)
    stores.set(session, store)
  }
  return store
}

export function apply(ctx, config) {
  const stores = new WeakMap()
  const anonymous = new DedupStore(config.maxEntries)
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 }

  // ── 1. dedup ──────────────────────────────────────────────────────────────
  if (config.dedup) {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      // Only an accepted, plain-text result is a candidate; a blocked or
      // rewritten one belongs to whoever rewrote it.
      if (decision.kind !== 'accept' || decision.content !== undefined) return decision
      const text = resultText(result.content)
      if (!eligible(exec.name, text, config)) return decision
      const store = exec.agent?.session === undefined
        ? anonymous
        : storeFor(stores, exec.agent.session, config.maxEntries)
      const seen = store.observe(exec.name, exec.arguments, text)
      if (!seen.repeat) return decision
      const pointer = pointerText(seen.entry, seen.digest, config.previewChars)
      // A pointer that is not decisively smaller buys nothing and costs the
      // model a redirection, so the original text stands.
      if (!worthReplacing(text.length, pointer.length, config.minSavingChars)) return decision
      store.countSaving(text.length, pointer.length)
      return { ...decision, content: [{ type: 'text', text: pointer }] }
    })
  }

  // ── 2. cache accounting ───────────────────────────────────────────────────
  ctx.on('llm/stream', (options, next) => (async function* () {
    usage.requests++
    for await (const chunk of next()) {
      if (chunk.type === 'usage') {
        usage.input += chunk.usage.inputTokens ?? 0
        usage.output += chunk.usage.outputTokens ?? 0
        usage.cacheRead += chunk.usage.cacheReadTokens ?? 0
        usage.cacheWrite += chunk.usage.cacheWriteTokens ?? 0
      }
      yield chunk
    }
  })())

  // ── 3. /context ───────────────────────────────────────────────────────────
  ctx.inject(['commands'], (cctx) => {
    cctx.effect(() => cctx.commands.register({
      name: 'context',
      description: 'Context window occupancy, distance to compaction, cache hits and dedup savings',
      recordInput: false,
      handler: async ({ agent }) => {
        const session = agent.session
        const store = stores.get(session) ?? anonymous
        const route = session.requestHeader?.()?.config
        let used
        let window
        const meter = ctx.get('tokenMeter')
        if (meter !== undefined) {
          try {
            used = meter.measure(session).totalTokens
          } catch {
            used = undefined
          }
        }
        if (route?.provider !== undefined && route.model !== undefined) {
          try {
            window = (await ctx.llm.resolveModelInfo(route.provider, route.model)).context.contextWindow
          } catch {
            window = undefined
          }
        }
        return {
          kind: 'success',
          text: contextReport({
            used,
            window,
            threshold: config.compactionThreshold,
            ...(route?.provider === undefined ? {} : { provider: route.provider, model: route.model }),
            usage,
            dedup: { hits: store.hits, savedChars: store.savedChars, calls: store.calls },
          }),
        }
      },
    }))
  })
}
