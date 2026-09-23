// dsh-ext-prune-pro — the model-free pass, with a memory of what is recoverable.
//
// Upstream runs this pass at the last moment: once context pressure qualifies,
// it prunes, remeasures, and skips the expensive LLM compaction entirely if the
// cheap pass alone got under the threshold. That makes how hard this pass bites
// the difference between a summarised conversation and an intact one.
//
// It bites harder here for one class of result: the ones that are a copy of
// something still on disk. A file read keeps 2.5k characters under the generic
// head/tail rule, and every one of those characters is a file the agent can
// re-read in a single call — or recover exactly, at this version, with
// `session_event_read` against the log. Those collapse to a pointer that says
// so. Everything else keeps upstream's treatment, by calling it.
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import z from '@deepseek-ai/schemastery'
import { REGENERABLE, pointerText, sourceOf, textChars, worthPointer } from './pointer.js'

export const name = 'ext-prune-pro'

export default class ProToolResultPruner extends ToolResultPruner {
  static inject = ['tokenMeter']

  static Config = z.object({
    // Upstream's three, forwarded verbatim: its resolveConfig rejects unknown
    // keys, so ours are stripped before the call to super.
    thresholdChars: z.number().step(1).min(1).default(4096),
    headChars: z.number().step(1).min(0).default(2048),
    tailChars: z.number().step(1).min(0).default(512),
    /** A regenerable result shorter than this is left alone. */
    pointerMinChars: z.number().step(1).min(1).default(1200),
    /** Tools whose results are treated as recoverable copies. */
    regenerableTools: z.array(z.string()).default(Object.keys(REGENERABLE)),
  })

  constructor(ctx, config = {}) {
    super(ctx, {
      ...config.thresholdChars === undefined ? {} : { thresholdChars: config.thresholdChars },
      ...config.headChars === undefined ? {} : { headChars: config.headChars },
      ...config.tailChars === undefined ? {} : { tailChars: config.tailChars },
    })
    this._pointerMinChars = config.pointerMinChars ?? 1200
    this._regenerable = new Set(config.regenerableTools ?? Object.keys(REGENERABLE))
  }

  /**
   * Which tool produced which result.
   *
   * Read from the LOG, not from the surface. A `tool/call` is not a surface
   * node — the surface carries the assistant message that contains the call as
   * a block, and the standalone call event is log-only. Walking the surface
   * therefore built an empty map, every result looked like it came from an
   * unknown tool, and the whole pointer pass silently did nothing. It cost a
   * deliberate run at a lowered threshold to see that, because nothing throws:
   * a no-op pass looks exactly like a pass with nothing to do.
   * @returns Map<callId, {name, arguments}>
   */
  _callsOf(session) {
    const calls = new Map()
    const total = session?.seq ?? 0
    for (let seq = 0; seq < total; seq += 1) {
      let event
      try {
        event = session.eventAt(seq)
      } catch {
        continue
      }
      if (event?.type !== 'tool/call') continue
      const id = event.data.callId ?? event.data.id
      if (id !== undefined) calls.set(id, { name: event.data.name, arguments: event.data.arguments })
    }
    return calls
  }

  /**
   * Replace recoverable results with a pointer, using the same durable protocol
   * upstream uses: a `compaction/prune` shadow price appended synchronously
   * adjacent to the replacement, so a pure consumer can subtract the shadowed
   * node without keeping per-node state.
   */
  _pointerPass(session) {
    const calls = this._callsOf(session)
    const pruned = []
    let charsRemoved = 0
    for (const seq of [...session.surface.nodes]) {
      const event = session.eventAt(seq)
      if (event?.type !== 'tool/result') continue
      const result = event.data.message.content[0]
      const callId = event.data.message.source?.callId
      const call = callId === undefined ? undefined : calls.get(callId)
      const tool = call?.name
      if (tool === undefined || !this._regenerable.has(tool)) continue
      // A failed call's message is usually the diagnosis, not a copy of a file.
      if (result?.isError === true) continue
      const chars = textChars(result.content)
      if (!worthPointer(tool, chars, this._pointerMinChars)) continue

      const text = pointerText({ tool, source: sourceOf(call.arguments, tool), chars, seq })
      // Text goes, everything else stays. A result may carry an image or a
      // file block beside its text, and those are not recoverable by re-reading
      // into THIS conversation — dropping them silently is how a pruning pass
      // turns into data loss.
      const kept = (result.content ?? []).filter((block) => block?.type !== 'text')
      const message = {
        ...event.data.message,
        content: [{ ...result, content: [{ type: 'text', text }, ...kept] }],
      }
      session.append('compaction/prune', {
        shadowedRange: { start: seq, end: seq },
        shadowedSeqs: [seq],
        shadowedTokenCount: this.ctx.tokenMeter.estimateMessage(event.data.message),
      })
      const replacement = session.append('tool/result', { ...event.data, message }, {
        surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
        sourceEventSeqs: [seq],
      })
      pruned.push({
        originalSeq: seq,
        replacementSeq: replacement.seq,
        callId,
        charsBefore: chars,
        charsAfter: Array.from(text).length,
      })
      charsRemoved += chars - Array.from(text).length
    }
    return { pruned, charsRemoved }
  }

  /**
   * Pointer pass first, then upstream's head/tail pass over what is left.
   * Order matters: a result already collapsed to a pointer is far under
   * upstream's threshold, so the second pass simply does not see it.
   */
  pruneSession(session) {
    let ours = { pruned: [], charsRemoved: 0 }
    try {
      ours = this._pointerPass(session)
    } catch (error) {
      // The generic pass is the one that must always run: a failure here costs
      // some savings, while a throw would cost the whole compaction.
      process.stderr.write(`ext-prune-pro: pointer pass failed: ${error?.message ?? error}\n`)
    }
    const rest = super.pruneSession(session)
    return {
      pruned: [...ours.pruned, ...rest.pruned],
      charsRemoved: ours.charsRemoved + rest.charsRemoved,
    }
  }
}
