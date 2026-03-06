/**
 * Domain-agnostic types for the plan/act/evaluate loop.
 */

/** Brain mode — controls which prompt set the brain uses. */
export type BrainMode = "select" | "triage" | "feature" | "review"

export interface Plan {
  steps: PlanStep[]
  reasoning: string
  procedure?: BrainMode  // set during select mode when brain picks a procedure
  targets?: string[]     // what the procedure focuses on (issue/PR numbers, etc.)
}

export interface PlanStep {
  task: string       // e.g. "mine", "travel", "sell", "dock", "refuel", "chat", "explore"
  goal: string       // NL goal for the subagent
  model: "haiku" | "sonnet"
  successCondition: string  // checked against game state
  timeoutTicks: number
}

export interface StepCompletionResult {
  complete: boolean
  reason: string
  matchedCondition: string | null
  relevantState: Record<string, unknown>
}

export interface StepTiming {
  task: string
  goal: string
  ticksBudgeted: number
  ticksConsumed: number
  overrun: boolean
  // Outcome fields — filled after evaluation
  succeeded?: boolean
  reason?: string
  stateDiff?: string
}

export interface Alert {
  priority: "critical" | "high" | "medium" | "low"
  message: string
  suggestedAction?: string
  ruleName?: string  // stable identifier from the interrupt rule
}

// --- Phase state machine types ---

export type ExitReason =
  | { readonly _tag: "PhaseComplete" }
  | { readonly _tag: "HookRequested"; readonly reason: string }
  | { readonly _tag: "ExternalSignal"; readonly reason: string }

export interface StateMachineResult {
  readonly finalState: unknown
  readonly exitReason: ExitReason
  readonly turnCount: number
}
