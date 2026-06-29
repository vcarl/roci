import type { DecideResult, WaitState, OrientResult } from "../skills/types.js"
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

/**
 * The steps of a plan decision, or [] for any other decision.
 *
 * A small conscious model can emit a parseable `{"decision":"plan"}` with no
 * `steps` (or `steps` a non-array). `parseOr`'s fallback is a DIFFERENT union
 * variant (`{decision:"continue",...}`) so it does not supply `steps` → a
 * "plan" decision can reach here with `steps` undefined/non-array. The
 * `Array.isArray` guard makes this always return a real array, so callers can
 * `.length` / `.map` / index it without throwing.
 */
export function planSteps(plan: DecideResult | null): readonly PlanStep[] {
  return decideSteps(plan)
}

/**
 * The actionable plan steps of a decide result — always a real array.
 * Returns [] unless `decide.decision === "plan"` AND `decide.steps` is a
 * genuine array. A "plan" decision whose `steps` is missing/non-array/empty
 * yields [] (no actionable steps), which the loop treats as "don't start a
 * plan" rather than crashing on `decide.steps.length`.
 */
export function decideSteps(decide: DecideResult | null): readonly PlanStep[] {
  if (decide && decide.decision === "plan" && Array.isArray(decide.steps)) {
    return decide.steps
  }
  return []
}

/**
 * Returns true when a discover decision has a well-formed payload: a `discover`
 * object whose `questions` is a non-empty array.
 *
 * Mirrors decideSteps: the static type says `discover` is non-optional on the
 * discover variant, but a small model can emit `{"decision":"discover","reasoning":"x"}`
 * with no `discover` key. The cast to unknown pierces the static type so we can do
 * the runtime check without TS complaining about a redundant optional-chain.
 * The loop-branch guard uses this to degrade safely instead of crashing in
 * discoverToPlan when `decide.discover` is undefined at runtime.
 */
export function isWellFormedDiscover(
  decide: DecideResult | null,
): decide is Extract<DecideResult, { decision: "discover" }> {
  if (!decide || decide.decision !== "discover") return false
  const raw = decide as unknown as { discover?: { questions?: unknown } }
  return (
    raw.discover !== undefined &&
    Array.isArray(raw.discover.questions) &&
    (raw.discover.questions as unknown[]).length > 0
  )
}

/**
 * Translate a `discover` decision into a synthetic one-step `plan` decision so it
 * reuses the existing step→evaluate execution path (hybrid-C — no new loop
 * machinery). The single step's `task` is "discover"; the questions become its
 * goal; tier and timeoutTicks carry straight through to the step's fields.
 */
export function discoverToPlan(
  decide: Extract<DecideResult, { decision: "discover" }>,
): DecideResult {
  return {
    decision: "plan",
    reasoning: decide.reasoning,
    steps: [
      {
        task: "discover",
        goal: `Discover your world. Answer: ${decide.discover.questions.join("; ")}`,
        tier: decide.discover.tier,
        successCondition:
          "Findings on environment, capabilities, and available paths reported back.",
        timeoutTicks: decide.discover.timeoutTicks,
      },
    ],
  }
}

/**
 * Literal marker the conscious agent is instructed to print when it has fully
 * met the current step's success condition. 4b ships the mechanism; phrasing
 * robustness tuning and the escalation-request marker are Phase 4c.
 */
export const STEP_DONE_MARKER = "[STEP_DONE]"

/**
 * Returns true if the output contains the completion marker, indicating the
 * agent self-reported success. Tolerant of surrounding text; case-sensitive.
 * runConsciousEvaluate remains the arbiter — a premature marker → replan/wait.
 */
export function detectCompletion(output: string): boolean {
  return output.includes(STEP_DONE_MARKER)
}

/**
 * Render a forebrain OrientResult into a concise steering directive.
 * The text is model-generated (laundered upstream by the forebrain) —
 * this function only formats; it never embeds raw inbound event text.
 */
export function formatSteerDirective(orient: OrientResult): string {
  const parts: string[] = [
    `Situation update: ${orient.headline}`,
    `What changed: ${orient.whatChanged}`,
  ]
  for (const section of orient.sections) {
    parts.push(`${section.heading}: ${section.body}`)
  }
  return parts.join("\n")
}

/** The instructions handed to the conscious agent for one plan step. */
export function formatStepTask(step: PlanStep, headline: string): string {
  return [
    `# Task: ${step.task}`,
    `Context: ${headline}`,
    `## Goal\n${step.goal}`,
    `## Success condition\n${step.successCondition}`,
    `Do this work now. When finished, report concisely what you did and whether the success condition is met. When you have fully met the success condition, print exactly: ${STEP_DONE_MARKER}`,
  ].join("\n\n")
}

/** Wrap a worker's text output as the execution report fed to evaluate. */
export function formatExecutionReport(output: string): string {
  const trimmed = output.trim()
  return trimmed.length > 0 ? trimmed : "Worker produced no output."
}
