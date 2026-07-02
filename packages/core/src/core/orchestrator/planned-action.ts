import { Effect, Queue, Option } from "effect"
import type { CharacterConfig } from "../../services/CharacterFs.js"
import { EventProcessorTag } from "../limbic/thalamus/event-processor.js"
import { SituationClassifierTag } from "../limbic/thalamus/situation-classifier.js"
import { InterruptRegistryTag } from "../limbic/amygdala/interrupt.js"
import type { PlannedActionTempo } from "../limbic/hypothalamus/tempo.js"
import { consolidate } from "../limbic/hippocampus/consolidate.js"
import { dream } from "../limbic/hippocampus/dream.js"
import type { Alert } from "../types.js"
import { logToConsole, logError, logBehavior } from "../../logging/log-writer.js"
import type { ModelConfig } from "../model-config.js"
import { CharacterFs } from "../../services/CharacterFs.js"
import { LongtermStore, newSinceMark, diaryMark } from "../../conscious/longterm-store.js"
import { finishEpisodeCycle } from "../../logging/episodes.js"

// ── Types ────────────────────────────────────────────────────

export interface BreakConfig {
  char: CharacterConfig
  events: Queue.Queue<unknown>
  initialState: unknown
  tempo: PlannedActionTempo
}

export type BreakResult =
  | { readonly _tag: "Completed"; readonly finalState: unknown }
  | { readonly _tag: "Interrupted"; readonly finalState: unknown; readonly criticals: Alert[] }

// ── runReflection ────────────────────────────────────────────

/**
 * Per-cycle reflection boundary (every cycle, all domains): first CONSOLIDATE the
 * diary (rewrite prior diary + this session's raw per-step appends into coherent
 * entries; may grow), then CULL via the dream (compress toward the target size,
 * clamped to never grow the file). The cull is unconditional — no size gate.
 */
export const runReflection = (
  char: CharacterConfig,
  containerId: string,
  models: ModelConfig,
  addDirs?: string[],
  env?: Record<string, string>,
) =>
  Effect.gen(function* () {
    // Issue 2 (fail loud, best-effort continuation): a consolidate/dream failure
    // must NOT be a low-visibility info line (logToConsole(..., "error") emits a
    // kind:"system" event that classifies to `info`). Emit a structured
    // kind:"error" event instead — and do NOT halt: a one-cycle reflection skip
    // is recoverable, but the next cycle proceeds with stale, unbounded memory,
    // so the failure has to be loud and diagnosable.
    // Deterministic promotion of RAW episodic entries (spec §5 Route 2 / §1.3),
    // run BEFORE consolidate rewrites the diary and before the destructive cull —
    // this is the rawest text available at this in-scope reflection seam. The loop
    // only appends `\n\n`-separated entries during a session, so the diary left by
    // the previous reflection is a verbatim PREFIX of the current one; a bounded
    // high-water mark (length + sha256 of that previous diary, in the db's meta
    // table) isolates exactly the new appends — no full-history scan, no
    // re-promotion across cycles. BEST-EFFORT: any embed/write failure logs loud
    // (kind:error) and does NOT block consolidate/cull (anti-loss skip).
    yield* Effect.gen(function* () {
      const charFs = yield* CharacterFs
      const store = yield* LongtermStore
      const diary = yield* charFs.readDiary(char)
      const mark = yield* store.readMark(containerId, char)
      const fresh = newSinceMark(diary, mark)
      const n = fresh.length === 0 ? 0 : yield* store.promote(containerId, char, fresh)
      if (n > 0) {
        yield* logToConsole(
          char.name,
          "orchestrator",
          `Reflecting — promoted ${n} raw diary entr${n === 1 ? "y" : "ies"} to long-term memory before cull`,
        )
      }
      yield* logBehavior(char.name, "hippocampus", "reflection", { type: "reflection", stage: "promote", status: "done", counts: { promoted: n } })
    }).pipe(
      Effect.catchAll((e) =>
        logError(char.name, "hippocampus", `Long-term promotion failed: ${e}`).pipe(
          Effect.catchAll(() => Effect.void),
        ),
      ),
    )

    // Issue 2 (fail loud, best-effort continuation): a consolidate/dream failure
    // must NOT be a low-visibility info line (logToConsole(..., "error") emits a
    // kind:"system" event that classifies to `info`). Emit a structured
    // kind:"error" event instead — and do NOT halt: a one-cycle reflection skip
    // is recoverable, but the next cycle proceeds with stale, unbounded memory,
    // so the failure has to be loud and diagnosable.
    yield* logBehavior(char.name, "hippocampus", "reflection", { type: "reflection", stage: "consolidate", status: "start" })
    yield* logToConsole(char.name, "orchestrator", "Reflecting — consolidating diary...")
    yield* consolidate.execute({ char, containerId, playerName: char.name, addDirs, env, models }).pipe(
      Effect.catchAll((e) =>
        logError(char.name, "hippocampus", `Consolidate failed: ${e}`).pipe(
          Effect.catchAll(() => Effect.void),
        ),
      ),
    )

    yield* logBehavior(char.name, "hippocampus", "reflection", { type: "reflection", stage: "dream", status: "start" })
    yield* logToConsole(char.name, "orchestrator", "Reflecting — dreaming (cull)...")
    yield* dream.execute({ char, containerId, playerName: char.name, addDirs, env, models }).pipe(
      Effect.catchAll((e) =>
        logError(char.name, "hippocampus", `Dream failed: ${e}`).pipe(
          Effect.catchAll(() => Effect.void),
        ),
      ),
    )

    // Re-baseline the promotion high-water mark to the diary AS LEFT by this
    // reflection (post-consolidate + cull). Next cycle's session appends to this
    // exact text, so marking it now lets the next promotion isolate only the new
    // raw appends. Best-effort: a failure leaves a stale mark, which the prefix
    // check degrades to a whole-diary re-promotion (anti-loss), logged loud.
    yield* Effect.gen(function* () {
      const charFs = yield* CharacterFs
      const store = yield* LongtermStore
      const culled = yield* charFs.readDiary(char)
      yield* store.writeMark(containerId, char, diaryMark(culled))
    }).pipe(
      Effect.catchAll((e) =>
        logError(char.name, "hippocampus", `Long-term mark update failed: ${e}`).pipe(
          Effect.catchAll(() => Effect.void),
        ),
      ),
    )

    // Close this reflection cycle's episode window and rotate (spec §1):
    // retain the last EPISODE_RETAIN_CYCLES cycles, dropping only whole
    // cycles. finishEpisodeCycle is swallow-and-log — it can never fail
    // reflection, mirroring the best-effort stages above.
    yield* finishEpisodeCycle(char.name)
  })

// ── runBreak ─────────────────────────────────────────────────

export const runBreak = (config: BreakConfig) =>
  Effect.gen(function* () {
    const eventProcessor = yield* EventProcessorTag
    const classifier = yield* SituationClassifierTag
    const interruptRegistry = yield* InterruptRegistryTag

    yield* logToConsole(
      config.char.name,
      "orchestrator",
      `Break phase — resting for ${config.tempo.breakDurationMs / 60_000} minutes (monitoring for critical interrupts)`,
    )

    const startTime = Date.now()
    let currentState = config.initialState

    while (Date.now() - startTime < config.tempo.breakDurationMs) {
      // Drain all pending events without blocking
      let drained = false
      while (!drained) {
        const maybeEvent = yield* Queue.poll(config.events)
        if (Option.isNone(maybeEvent)) {
          drained = true
        } else {
          const event = maybeEvent.value
          const result = yield* Effect.try(() =>
            eventProcessor.processEvent(event, currentState)
          ).pipe(
            Effect.catchAll((e) =>
              logError(config.char.name, "orchestrator", `Event processing error during break: ${e}`).pipe(
                Effect.catchAll(() => Effect.void),
                Effect.map(() => ({ category: undefined, stateUpdate: undefined, log: undefined })),
              ),
            ),
          )

          if (result.stateUpdate) {
            currentState = result.stateUpdate(currentState)
          }

          if (result.log) {
            result.log()
          }

          // Only check for critical interrupts on state changes
          if (result.category?._tag === "StateChange") {
            const summary = classifier.summarize(currentState)
            const criticals = interruptRegistry.criticals(currentState, summary.situation)

            if (criticals.length > 0) {
              yield* logToConsole(
                config.char.name,
                "orchestrator",
                `Critical interrupt during break: ${criticals.map(a => a.message).join("; ")} — waking up`,
              )
              return {
                _tag: "Interrupted" as const,
                finalState: currentState,
                criticals,
              }
            }
          }
        }
      }

      yield* Effect.sleep(`${config.tempo.breakPollIntervalSec} seconds`)
    }

    const elapsedMin = Math.round((Date.now() - startTime) / 60_000)
    yield* logToConsole(config.char.name, "orchestrator", `Break complete (${elapsedMin} min) — proceeding to reflection`)

    return {
      _tag: "Completed" as const,
      finalState: currentState,
    }
  })
