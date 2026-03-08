import { Effect } from "effect"
import type { Plan, PlanStep, StepCompletionResult } from "../../types.js"

/**
 * Context passed to the beforePlan hook.
 * Intentionally avoids generic S/Sit — hooks inject string context,
 * not typed state.
 */
export interface PlanContext {
  briefing: string
  state: unknown
  situation: unknown
  diary: string
  previousFailure?: string
}

/**
 * Hooks that let phases observe and influence the state machine lifecycle.
 * All hooks are optional — when absent, the state machine behaves exactly
 * as before (infinite loop, no callbacks).
 *
 * Transform hooks receive data and return (possibly modified) data.
 * The state machine uses the returned value instead of the original.
 */
export interface LifecycleHooks {
  /** Called before the brain requests a new plan. Returns enrichment for the brain. */
  readonly beforePlan?: (ctx: PlanContext) => Effect.Effect<{ additionalContext?: string }>
  /** Called after a plan has been produced by the brain. Returns (possibly modified) plan. */
  readonly afterPlan?: (plan: Plan) => Effect.Effect<Plan>
  /** Called before a subagent is spawned for a step. Returns (possibly modified) step. */
  readonly beforeStep?: (stepIndex: number, step: PlanStep) => Effect.Effect<PlanStep>
  /** Called after a step has been evaluated (success or failure). Returns (possibly modified) result. */
  readonly afterStep?: (stepIndex: number, result: StepCompletionResult) => Effect.Effect<StepCompletionResult>
  /** Called when an interrupt is processed. Observe-only. */
  readonly onInterrupt?: (alerts: Array<{ priority: string; message: string }>) => Effect.Effect<void>
  /** Called when a reset event is processed (e.g. character death). Observe-only. */
  readonly onReset?: () => Effect.Effect<void>
  /**
   * Called when a procedure completes (plan finished in a non-"select" mode).
   * Fires after the diary subagent and mode reset.
   */
  readonly onProcedureComplete?: (procedureName: string) => Effect.Effect<void>
  /**
   * Called after each event iteration.
   * Receives the current turn count for informed decisions.
   * Return true to signal the state machine should exit.
   */
  readonly shouldExit?: (turnCount: number) => Effect.Effect<boolean>
}
