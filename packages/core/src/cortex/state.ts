import type { DecideResult, WaitState } from "../skills/types.js"
import type { PlanStep } from "../core/types.js"

export interface CortexState {
  accumulatedEvents: string[]
  emotionalWeight: string
  currentPlan: DecideResult | null
  currentStepIndex: number
  waitState: WaitState | null
  lastOrientTick: number
}

export function freshCortexState(): CortexState {
  return {
    accumulatedEvents: [],
    emotionalWeight: "",
    currentPlan: null,
    currentStepIndex: 0,
    waitState: null,
    lastOrientTick: 0,
  }
}

/** Force an orient when events have piled up for `orientInterval` ticks without one. */
export function shouldForceOrient(state: CortexState, tick: number, orientInterval: number): boolean {
  return state.accumulatedEvents.length > 0 && tick - state.lastOrientTick >= orientInterval
}

/** The steps of a plan decision, or [] for any other decision. */
export function planSteps(plan: DecideResult | null): readonly PlanStep[] {
  return plan && plan.decision === "plan" ? plan.steps : []
}

/** The instructions handed to a cybernetic worker for one plan step. */
export function formatStepTask(step: PlanStep, headline: string): string {
  return [
    `# Task: ${step.task}`,
    `Context: ${headline}`,
    `## Goal\n${step.goal}`,
    `## Success condition\n${step.successCondition}`,
    `Do this work now. When finished, report concisely what you did and whether the success condition is met.`,
  ].join("\n\n")
}

/** Wrap a worker's text output as the execution report fed to evaluate. */
export function formatExecutionReport(output: string): string {
  const trimmed = output.trim()
  return trimmed.length > 0 ? trimmed : "Worker produced no output."
}
