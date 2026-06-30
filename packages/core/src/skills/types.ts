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
 * Result of the decide skill — what the agent chooses to do.
 */
export type DecideResult =
  | {
      readonly decision: "plan"
      readonly reasoning: string
      readonly steps: ReadonlyArray<PlanStep>
    }
  | { readonly decision: "continue"; readonly reasoning: string }
  | { readonly decision: "wait"; readonly reasoning: string; readonly wait: WaitState }
  | { readonly decision: "terminate"; readonly reasoning: string; readonly summary: string }
  | {
      readonly decision: "discover"
      readonly reasoning: string
      readonly discover: {
        readonly questions: ReadonlyArray<string>
        readonly tier: "fast" | "smart"
        readonly timeoutTicks: number
      }
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
}
