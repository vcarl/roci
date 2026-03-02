import { Effect, Ref } from "effect"
import type { StepTiming } from "./types.js"

export interface TimingRefs {
  readonly tickCount: Ref.Ref<number>
  readonly stepStartTick: Ref.Ref<number>
  readonly stepTimingHistory: Ref.Ref<StepTiming[]>
}

/** Record timing for a completed step. Returns the timing entry. */
export const recordStepTiming = (
  refs: TimingRefs,
  task: string,
  goal: string,
  ticksBudgeted: number,
) =>
  Effect.gen(function* () {
    const startTick = yield* Ref.get(refs.stepStartTick)
    const currentTick = yield* Ref.get(refs.tickCount)
    const ticksConsumed = currentTick - startTick
    const overrun = ticksConsumed > ticksBudgeted
    const timing: StepTiming = { task, goal, ticksBudgeted, ticksConsumed, overrun }
    yield* Ref.update(refs.stepTimingHistory, (history) => [...history.slice(-9), timing])
    return timing
  })

/** Annotate the most recent timing entry with outcome info. */
export const recordStepOutcome = (
  stepTimingHistoryRef: Ref.Ref<StepTiming[]>,
  succeeded: boolean,
  reason: string,
  stateDiffStr: string,
) =>
  Ref.update(stepTimingHistoryRef, (history) => {
    if (history.length === 0) return history
    const last = { ...history[history.length - 1], succeeded, reason, stateDiff: stateDiffStr }
    return [...history.slice(0, -1), last]
  })
