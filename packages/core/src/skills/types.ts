import type { PlanStep } from "../core/types.js"

/**
 * Disposition — how observe classifies an incoming event.
 */
export type Disposition = "discard" | "accumulate" | "escalate"

/**
 * Result of the observe skill — the per-event appraisal of ONE incoming event
 * (Subteam A / limbic drives). The hindbrain is invoked once per state-changing
 * event and returns a single object tagging that event against the character's
 * innate drives. (Inert events are tagged deterministically by the fast-path,
 * never the model.)
 */
export interface ObserveResult {
  readonly disposition: Disposition
  /** Emoji mood line painted from the character's palette: each palette row is a
   *  5-emoji gradient between two poles — position = where you sit, repeats =
   *  intensity, mixed rows = a chord. */
  readonly emotionalWeight: string
  /** Which innate drive (core safety/sustenance/agency or a domain drive) this
   *  event bears on, or `null` for none. Validated against the closed drive
   *  vocabulary; an unknown label degrades to `null`. */
  readonly drive: string | null
  /** 0–5 salience/threat weight for THIS event. Clamped to the band. */
  readonly weight: number
  /**
   * This event's position across the character's SALIENCE AXES — the producer
   * (C) stage of the scoring pipeline (design 2026-07-31 §3), emitted free in a
   * call the hindbrain is already making.
   *
   * Deliberately ADDITIVE, not a replacement for `drive`/`weight`. Those two
   * drive escalation (`appraiseTick`, the rung table, `guardAppraisal`) and
   * design §1/§7 are explicit that escalation behavior does not change — so
   * they keep their meaning and this rides alongside. Drive axes are `[0,1]`;
   * palette axes are `[-1,+1]` with the first pole negative (§6). Validated
   * against the closed axis vocabulary by `sanitizeSalienceVector`; absent when
   * no vocabulary was available.
   *
   * An ALL-ZERO reading collapses to `{}` there rather than being stored: a
   * model scoring every axis 0 is saying "no reading", and kept it would ship as
   * `--dims-c` and halve the mechanical A vector on every axis it names
   * (task-12 review). A mix of zeros and non-zeros is kept intact.
   */
  readonly salience?: Record<string, number>
  /** Drop-everything signal. Default false. Gates the hard-interrupt rung
   *  (§3.2). The 2B hindbrain caps at `reorient`; this flag exists so the
   *  amygdala / a future stronger tier can drive an in-loop interrupt, and so a
   *  genuine physical-attack appraisal (redundant with the amygdala) is honored. */
  readonly interrupt?: boolean
  /** Brief note on why this disposition was chosen. */
  readonly reason: string
}

/**
 * Result of the orient skill — structured situation assessment.
 */
export interface OrientResult {
  readonly headline: string
  readonly sections: ReadonlyArray<{
    readonly id: string
    readonly heading: string
    readonly body: string
  }>
  readonly whatChanged: string
  /** Emotional state — carried forward from observe, potentially amplified. */
  readonly emotionalState: string
  /** Self-assessed footing in the world. Low = flying blind (unknown tools /
   *  affordances / paths) → biases the decider toward `discover`. */
  readonly confidence: "low" | "medium" | "high"
  readonly metrics: Record<string, string | number | boolean>
  /**
   * Where this situation sits across the character's SALIENCE AXES — the
   * producer (C) stage of the scoring pipeline (design 2026-07-31 §3, pathway
   * 2), emitted in the orient call the forebrain is already making.
   *
   * ONE vector per orient result, stamped on every memory that result produces:
   * the tier is scoring the situation, not each fragment of its own write-up.
   * Drive axes `[0,1]`, palette axes `[-1,+1]` with the first pole negative.
   * Validated against the closed axis vocabulary; absent when none was available.
   */
  readonly salience?: Record<string, number>
}

/**
 * What the agent is waiting for when it enters a wait state.
 */
export interface WaitState {
  /** Human-readable description of what we're waiting for. */
  readonly waitingFor: string
  /** What event would resolve the wait — observe uses this to know when to escalate. */
  readonly resolutionSignal: string
  /** Whether to hold the session open or terminate and resume next session. */
  readonly disposition: "hold" | "terminate"
}

/**
 * Result of the decide skill — what the agent chooses to do. `skill` (spec §3)
 * is an OPTIONAL agent-maintained skill the model chose to wear for this work,
 * by name; the loop resolves it to a body injected into the step task. Kept a
 * string-or-absent value by sanitizeDecideSkill (state.ts) against small-model
 * junk. Orthogonal to the decision, so it is optional on every variant.
 *
 * `salience` is the producer (C) vector for this decision — where it sits across
 * the character's salience axes (design 2026-07-31 §3, pathway 3), emitted in
 * the call the conscious tier is already making. Like `skill` it is orthogonal
 * to the decision and therefore optional on every variant. Drive axes `[0,1]`,
 * palette axes `[-1,+1]` with the first pole negative; validated against the
 * closed axis vocabulary before it can be stored.
 */
export type DecideResult =
  | {
      readonly decision: "plan"
      readonly reasoning: string
      readonly steps: ReadonlyArray<PlanStep>
      readonly skill?: string
      readonly salience?: Record<string, number>
    }
  | { readonly decision: "continue"; readonly reasoning: string; readonly skill?: string; readonly salience?: Record<string, number> }
  | { readonly decision: "wait"; readonly reasoning: string; readonly wait: WaitState; readonly skill?: string; readonly salience?: Record<string, number> }
  | { readonly decision: "terminate"; readonly reasoning: string; readonly summary: string; readonly skill?: string; readonly salience?: Record<string, number> }
  | {
      readonly decision: "discover"
      readonly reasoning: string
      readonly discover: {
        readonly questions: ReadonlyArray<string>
        readonly tier: "fast" | "smart"
        readonly timeoutTicks: number
      }
      readonly skill?: string
      readonly salience?: Record<string, number>
    }

/**
 * Judgment on whether a step succeeded.
 */
export type Judgment = "succeeded" | "partially_succeeded" | "failed"

/**
 * Transition after evaluation — what happens next.
 */
export type EvaluateTransition =
  | { readonly transition: "next_step" }
  | { readonly transition: "replan"; readonly reason: string }
  | { readonly transition: "wait"; readonly wait: WaitState }
  | { readonly transition: "terminate"; readonly summary: string }

/**
 * Result of the evaluate skill — judgment plus transition.
 */
export interface EvaluateResult {
  readonly judgment: Judgment
  readonly reasoning: string
  readonly transition: EvaluateTransition
  /**
   * Where this outcome sits across the character's salience axes — the producer
   * (C) vector for pathway 4 (design 2026-07-31 §3), emitted in the evaluate
   * call the tier already makes. Drive axes `[0,1]`, palette axes `[-1,+1]` with
   * the first pole negative; validated against the closed axis vocabulary.
   */
  readonly salience?: Record<string, number>
}
