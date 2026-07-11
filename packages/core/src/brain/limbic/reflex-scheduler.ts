import { Effect, Fiber, Option } from "effect"
import type { ModelClient } from "../../model/client.js"
import type { ModelService } from "../../services/ModelService.js"
import { type CharacterLog, logToConsole } from "../../logging/log-writer.js"
import type { ObserveResult, WaitState } from "../../skills/types.js"
import { MemoryGateway, observeMemories } from "#brain/limbic/hippocampus/memory/memory-gateway.js"
import { runHindbrain } from "#brain/limbic/tiers-limbic.js"
import type { ActivationRunnerConfig } from "#brain/stem/tier-config.js"

/**
 * One landed per-event appraisal: the raw event text plus its validated
 * `ObserveResult`, ready to feed the tick's `appraiseTick` reduce.
 */
export interface ReflexAppraisal {
  readonly event: string
  readonly observe: ObserveResult
}

/**
 * The limbic-owned reflex scheduler (Phase B2). It forks each state-changing
 * event's hindbrain appraisal (`runHindbrain` + the per-event
 * `observeMemories → remember` write) OFF the conductor's hot path, so a slow
 * 2B reflex (observed up to ~17.5 min) can no longer freeze the tick loop —
 * event draining and the synchronous amygdala critical-interrupt path keep
 * running while a reflex is in flight ("finding G").
 *
 * ORDERING CONTRACT (load-bearing — see LIMBIC.md §2 + BRAIN.md invariant #1):
 *  - `submit` forks; it never blocks the caller.
 *  - `drainReady` non-blockingly collects the reflexes that have LANDED, in
 *    submission order (FIFO). A reflex submitted on tick T that has not landed
 *    by T's reduce is simply not in T's drain — it is consumed on the tick it
 *    lands (T+k). Escalations therefore QUEUE and are consumed exactly once,
 *    never dropped and never misordered relative to each other.
 *  - The amygdala hard-interrupt path stays synchronous in the loop and is NOT
 *    routed through here, so a "cut-the-line" critical is never deferred behind
 *    a pending reflex. (The hindbrain `interrupt` rung — a softer supersede
 *    signal, capped at `reorient` by the 2B in practice — may land a tick late;
 *    that is safe and intended.)
 *  - A reflex whose model call FAILS degrades to a non-escalating `accumulate`
 *    appraisal (mirroring `runHindbrain`'s own parse-miss default) rather than
 *    crashing the conductor: off-hot-path robustness over deferred-crash-loud.
 *    The event text still accumulates; it simply earns weight 0.
 */
export interface ReflexScheduler {
  /**
   * Fork one state-changing event's appraisal (hindbrain observe + its memory
   * write). Returns immediately; the appraisal lands via `drainReady`.
   */
  readonly submit: (
    event: string,
    waitState: WaitState | null,
  ) => Effect.Effect<void, never, ModelClient | ModelService | CharacterLog | MemoryGateway>
  /** Non-blocking poll: the appraisals that have landed since the last drain, FIFO. */
  readonly drainReady: () => Effect.Effect<ReflexAppraisal[]>
  /** Interrupt every in-flight reflex (used on the amygdala critical exit — a dropped session's reflexes are moot). */
  readonly interruptAll: () => Effect.Effect<void>
  /** Count of reflexes still in flight (diagnostics / tests). */
  readonly pending: () => number
}

/**
 * The degraded appraisal for a reflex whose 2B model call failed
 * (`ModelError`/`SpawnError`/`ReadinessError`). `accumulate`/weight-0 so the
 * event text still accumulates for the forebrain but earns no escalation —
 * a flaky reflex never freezes NOR falsely wakes the conductor.
 */
const REFLEX_ERROR_APPRAISAL: ObserveResult = {
  disposition: "accumulate",
  emotionalWeight: "😐",
  drive: null,
  weight: 0,
  interrupt: false,
  reason: "reflex model error — degraded to accumulate (off-hot-path)",
}

/**
 * Build a fresh reflex scheduler for one `runActivation` invocation. Holds the
 * in-flight fibers in closure state; the loop drives it via `submit` /
 * `drainReady` / `interruptAll`.
 */
export function makeReflexScheduler(config: ActivationRunnerConfig, containerId: string): ReflexScheduler {
  const char = config.char
  let inflight: Array<Fiber.RuntimeFiber<ReflexAppraisal, never>> = []

  const submit = (event: string, waitState: WaitState | null) =>
    Effect.gen(function* () {
      // The whole reflex — appraise + its memory write — runs on the forked
      // fiber, so nothing about it touches the conductor's hot path. Never-fail
      // (catchAll ⇒ error channel `never`), mirroring the loop's deliberation
      // fork: a model error degrades to a safe non-escalating appraisal.
      const work = Effect.gen(function* () {
        const observe = yield* runHindbrain(config, event, waitState)
        const memory = yield* MemoryGateway
        for (const w of observeMemories(observe)) {
          yield* memory.remember(containerId, char, w)
        }
        return { event, observe } satisfies ReflexAppraisal
      }).pipe(
        Effect.catchAll((e) =>
          logToConsole(char.name, "cortex", `hindbrain reflex failed; degraded to accumulate: ${e}`, "warn").pipe(
            Effect.catchAll(() => Effect.void),
            Effect.as({ event, observe: REFLEX_ERROR_APPRAISAL } satisfies ReflexAppraisal),
          ),
        ),
      )
      const fiber = yield* Effect.fork(work)
      inflight.push(fiber)
    })

  const drainReady = () =>
    Effect.gen(function* () {
      const ready: ReflexAppraisal[] = []
      const still: Array<Fiber.RuntimeFiber<ReflexAppraisal, never>> = []
      // FIFO scan preserves submission order in the returned batch — the reduce
      // sees landed reflexes in the order they were submitted.
      for (const fiber of inflight) {
        const polled = yield* Fiber.poll(fiber)
        if (Option.isSome(polled)) {
          // Never-fail fiber ⇒ the Exit is always a Success; join yields the value.
          ready.push(yield* Fiber.join(fiber))
        } else {
          still.push(fiber)
        }
      }
      inflight = still
      return ready
    })

  const interruptAll = () =>
    Effect.gen(function* () {
      const fibers = inflight
      inflight = []
      yield* Effect.forEach(fibers, (f) => Fiber.interrupt(f), { discard: true })
    })

  return { submit, drainReady, interruptAll, pending: () => inflight.length }
}
