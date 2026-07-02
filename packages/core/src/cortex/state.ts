import type { DecideResult, Disposition, ObserveResult, WaitState, OrientResult } from "../skills/types.js"
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

// ── Limbic drives: per-event appraisal + per-tick escalation ───────────────

/** The escalation ladder (§3.2). Ordered least→most disruptive. */
export type EscalationRung = "none" | "accumulate" | "steer" | "reorient" | "interrupt"

const RUNG_RANK: Record<EscalationRung, number> = {
  none: 0,
  accumulate: 1,
  steer: 2,
  reorient: 3,
  interrupt: 4,
}

/** Weight thresholds for the graded ladder. STEER ≈ 4, REORIENT ≈ 5 (§3.2). */
export interface AppraisalThresholds {
  readonly steer: number
  readonly reorient: number
}

/** Default thresholds, tunable per cadence profile (alongside DEFAULT_STEER_CADENCE_TICKS). */
export const DEFAULT_APPRAISAL_THRESHOLDS: AppraisalThresholds = { steer: 4, reorient: 5 }

/**
 * The aggregated per-tick escalation signal (§4.4), reduced from the tick's
 * per-event `ObserveResult`s and consumed directly by the tick loop.
 */
export interface HindbrainEscalation {
  /** The MAX rung across the tick's events (§3.2 ladder). */
  readonly rung: EscalationRung
  /** The highest per-event weight seen this tick (clamped 0–5). */
  readonly maxWeight: number
  /** True when `rung` is `steer` or higher — the only signal the forebrain-wake session needs. */
  readonly escalate: boolean
  /** The highest-weight event's appraisal — drives the tick mood. null when no events. */
  readonly dominant: ObserveResult | null
  /** Raw text of every non-discard event, for `accumulatedEvents`. */
  readonly accumulated: ReadonlyArray<string>
}

/** A well-formed, non-escalating escalation — the every-tick default and the empty result. */
export function emptyEscalation(): HindbrainEscalation {
  return { rung: "none", maxWeight: 0, escalate: false, dominant: null, accumulated: [] }
}

const DISPOSITIONS: ReadonlySet<Disposition> = new Set(["discard", "accumulate", "escalate"])

/** Clamp any value to an integer in [0, 5]; non-numeric → 0. */
function clampWeight(w: unknown): number {
  const n = typeof w === "number" ? w : Number(w)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(5, Math.round(n)))
}

/** Normalize a raw drive label: null-ish → null; otherwise lowercased+trimmed. */
function normalizeDrive(raw: unknown, knownDrives?: ReadonlyArray<string>): string | null {
  if (raw === null || raw === undefined) return null
  const s = String(raw).trim().toLowerCase()
  if (s === "" || s === "null" || s === "none") return null
  if (knownDrives && knownDrives.length > 0) {
    const known = knownDrives.map((d) => d.toLowerCase())
    return known.includes(s) ? s : null
  }
  return s
}

/**
 * Validate + clamp a single (possibly-malformed) per-event appraisal into a
 * well-formed `ObserveResult`. Pure; never throws. `weight` is clamped to 0–5,
 * `drive` validated against the closed vocabulary (`knownDrives`) → null on
 * miss, `disposition` defaulted to the safe `accumulate`, `interrupt` coerced to
 * a strict boolean (default false). The model's structured output passes through
 * here before it can drive control flow.
 */
export function appraise(
  raw: Partial<ObserveResult> | Record<string, unknown>,
  knownDrives?: ReadonlyArray<string>,
): ObserveResult {
  const r = raw as Record<string, unknown>
  const disposition = DISPOSITIONS.has(r.disposition as Disposition)
    ? (r.disposition as Disposition)
    : "accumulate"
  const emotionalWeight = typeof r.emotionalWeight === "string" && r.emotionalWeight.length > 0
    ? r.emotionalWeight
    : "😐"
  const interrupt = r.interrupt === true || r.interrupt === "true"
  return {
    disposition,
    emotionalWeight,
    drive: normalizeDrive(r.drive, knownDrives),
    weight: clampWeight(r.weight),
    interrupt,
    reason: typeof r.reason === "string" ? r.reason : "",
  }
}

/** The escalation rung a single appraised event earns (§3.2). */
function eventRung(o: ObserveResult, thresholds: AppraisalThresholds): EscalationRung {
  // Hard-interrupt is gated behind an explicit `interrupt:true` — never weight
  // alone (the 2B caps at reorient; this rung exists for the amygdala / a future
  // stronger tier / a genuine redundant physical-attack appraisal — §3.2 REV3).
  if (o.interrupt === true) return "interrupt"
  const w = clampWeight(o.weight)
  if (w >= thresholds.reorient) return "reorient"
  // An `escalate` disposition floors the event at steer even when weight is low.
  if (w >= thresholds.steer || o.disposition === "escalate") return "steer"
  if (o.disposition !== "discard") return "accumulate"
  return "none"
}

/**
 * Reduce the tick's per-event appraisals into one `HindbrainEscalation` (§4.4).
 * Pure. The tick rung is the MAX rung across events; `dominant` is the
 * highest-weight event (ties → first); `accumulated` is the raw text of every
 * non-discard event.
 */
export function appraiseTick(
  results: ReadonlyArray<{ event: string; observe: ObserveResult }>,
  thresholds: AppraisalThresholds,
): HindbrainEscalation {
  if (results.length === 0) return emptyEscalation()

  let rung: EscalationRung = "none"
  let maxWeight = 0
  let dominant: ObserveResult | null = null
  const accumulated: string[] = []

  for (const { event, observe } of results) {
    const w = clampWeight(observe.weight)
    const r = eventRung(observe, thresholds)
    if (RUNG_RANK[r] > RUNG_RANK[rung]) rung = r
    if (dominant === null || w > maxWeight) {
      maxWeight = w
      dominant = observe
    }
    if (observe.disposition !== "discard") accumulated.push(event)
  }

  return {
    rung,
    maxWeight,
    escalate: RUNG_RANK[rung] >= RUNG_RANK.steer,
    dominant,
    accumulated,
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
 * The execution-block invariant: an "active" plan (`currentPlan !== null`) whose
 * actionable steps are empty. Such a plan would wedge the loop — the execution
 * block keeps finding no step at `currentStepIndex`, never executes, never
 * evaluates, never advances. The plan-assignment guard (`decideSteps(...).length
 * > 0`) makes this unreachable through the normal path, so a `true` here signals
 * a genuine invariant violation the loop must fail loudly on and self-heal from.
 */
export function isWedgedEmptyPlan(currentPlan: DecideResult | null): boolean {
  return currentPlan !== null && decideSteps(currentPlan).length === 0
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
