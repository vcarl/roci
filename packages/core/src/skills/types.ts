/**
 * Disposition — how observe classifies an incoming event.
 */
export type Disposition = "discard" | "accumulate" | "escalate"

/**
 * Result of the observe skill — event triage with emotional response.
 */
export interface ObserveResult {
  readonly disposition: Disposition
  /** Emoji string encoding gut reaction. Intensity = count, character = valence. */
  readonly emotionalWeight: string
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
      readonly steps: ReadonlyArray<{
        readonly task: string
        readonly goal: string
        readonly successCondition: string
        readonly tier: "fast" | "smart"
        readonly timeoutTicks: number
      }>
    }
  | { readonly decision: "continue"; readonly reasoning: string }
  | { readonly decision: "wait"; readonly reasoning: string; readonly wait: WaitState }
  | { readonly decision: "terminate"; readonly reasoning: string; readonly summary: string }

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
  /** Optional diary entry — evaluate is where the agent learns within a session. */
  readonly diaryEntry?: string
}
