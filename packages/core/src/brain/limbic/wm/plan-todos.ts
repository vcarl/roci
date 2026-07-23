/**
 * Plan-todo bookkeeping tracker (agent-cognition Stage 2, spec §2).
 *
 * The harness seeds each decide-chosen plan as a headline todo plus one child
 * per step, so plan intent survives replans and shows up in the injected WM.md.
 * The ids of those seeded todos (`headlineId` + the parallel `stepIds` array)
 * are per-run bookkeeping the cortex loop used to juggle as two inline `let`s,
 * threading them through the decide seed, the per-step done/close settlement,
 * the reorient/interrupt orphan discard, and the critical-exit orphan discard.
 *
 * This owner co-locates that state with the composite wm sequences that read
 * and mutate it (spec §2 lifecycle), mirroring the conscious-session owner
 * (cortex/conscious/conscious-session.ts) and the reflex scheduler
 * (limbic/reflex-scheduler.ts). It composes ONLY `limbic/wm/wm-store.js` calls
 * and returns the applied `WmDelta[]` for the loop to record on episode records
 * — it imports NO logging/cortex code, so the layer wall stays clean and the
 * loop remains the single site that pairs wm deltas with episode records.
 *
 * Closure `let`s are safe here for the same reason the loop's were: the tick
 * loop is single-fiber and only the loop fiber drives this owner; the turn/
 * deliberation fibers never touch it. No Effect `Ref` is needed.
 */
import { Effect } from "effect"
import type { CharacterConfig } from "../../../services/CharacterFs.js"
import type { PlanStep } from "../../../core/types.js"
import type { WmDelta } from "@roci/player-tools/wm-core"
import { closePlanTodos, drainWmDeltas, mutateWm, seedWmPlan } from "./wm-store.js"

/** The evaluate transition names that END the active plan (drop it). */
type PlanEndingTransition = "replan" | "wait" | "terminate"

export interface PlanTodoTracker {
  /**
   * Decide-time seeding: seed the plan's steps as todos under a headline todo
   * (seedWmPlan), adopt the created ids as this run's active-plan bookkeeping,
   * and return the seed deltas for the loop to emit as a type:"wm" record.
   */
  seed(headline: string, steps: readonly PlanStep[]): Effect.Effect<WmDelta[]>
  /**
   * Per-step settlement on evaluate (spec §2). Marks the just-finished step's
   * seeded todo done FIRST (so closePlanTodos sees it on disk when weighing the
   * headline), then — when the transition drops the plan (replan/wait/terminate)
   * or the plan just completed (last step, next_step off the end) — settles the
   * headline + discards any still-open step children via closePlanTodos, and
   * clears the tracked ids. Finally drains the agent journal. Returns the full
   * step wm story ordered exactly as the loop assembled it inline:
   * `[...agentDeltas, ...doneDeltas, ...planCloseDeltas]`.
   */
  settleStep(
    stepIndex: number,
    transition: "next_step" | PlanEndingTransition,
    stepCount: number,
  ): Effect.Effect<WmDelta[]>
  /**
   * Discard the seeded todos a dropped plan leaves behind (reorient/interrupt
   * rungs and the critical-interrupt exit), headline included. Clears the
   * tracked ids and returns the discard deltas (empty when no plan was seeded).
   * Does NOT drain the agent journal — callers combine that themselves where
   * they need it (resetPlanState), so the drain ordering stays theirs.
   */
  discardOrphans(): Effect.Effect<WmDelta[]>
}

/**
 * Construct the tracker for one cortex run. `char` is the only construction-time
 * constant; the seeded ids accumulate across the run's plans.
 */
export function makePlanTodoTracker(char: CharacterConfig): PlanTodoTracker {
  // ids of the harness-seeded plan todos — the headline todo plus one child per
  // step (parallel to the plan's steps). "" marks a step whose seed was skipped
  // (wm degraded); filtered out before any id is treated as a real todo.
  let headlineId: string | null = null
  let stepIds: string[] = []

  const settlePlan = (openStepIds: readonly string[]) =>
    Effect.gen(function* () {
      const id = headlineId
      headlineId = null
      stepIds = []
      return yield* closePlanTodos(char, id, openStepIds)
    })

  return {
    seed: (headline, steps) =>
      Effect.gen(function* () {
        const seeded = yield* seedWmPlan(char, headline, steps)
        headlineId = seeded.headlineId
        stepIds = seeded.stepIds
        return seeded.deltas
      }),

    settleStep: (stepIndex, transition, stepCount) =>
      Effect.gen(function* () {
        // The just-finished step's seeded todo → done FIRST, so closePlanTodos
        // sees it on disk when weighing the headline (done-if-any-child-done).
        const stepTodoId = stepIds[stepIndex] || null
        const doneDeltas = stepTodoId
          ? yield* mutateWm(char, [{ verb: "done", id: stepTodoId }])
          : []
        let planCloseDeltas: WmDelta[] = []
        if (transition === "replan" || transition === "wait" || transition === "terminate") {
          // Plan-dropping transition: discard the remaining OPEN step children
          // and settle the headline (done-if-any-child-done, discarded else).
          planCloseDeltas = yield* settlePlan(stepIds.filter((s) => s !== "" && s !== stepTodoId))
        } else if (stepIndex + 1 >= stepCount) {
          // next_step off the end = plan complete: every step done → the
          // headline settles done (closePlanTodos, no open children left).
          planCloseDeltas = yield* settlePlan([])
        }
        // Drain the agent journal LAST; spread FIRST — byte-identical to the
        // loop's old `[...agentDeltas, ...doneDeltas, ...planCloseDeltas]`.
        const agentDeltas = yield* drainWmDeltas(char)
        return [...agentDeltas, ...doneDeltas, ...planCloseDeltas]
      }),

    discardOrphans: () =>
      Effect.gen(function* () {
        const id = headlineId
        const ids = stepIds.filter((s) => s !== "")
        headlineId = null
        stepIds = []
        if (id === null && ids.length === 0) return [] as WmDelta[]
        return yield* closePlanTodos(char, id, ids)
      }),
  }
}
