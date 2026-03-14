/**
 * Homeostatic timing parameters — how a domain configures the
 * tempo of the limbic system's cyclic regulation.
 */
export interface TempoBase {
  readonly tickIntervalSec: number
  readonly dreamThreshold: number
}

export interface StateMachineTempo extends TempoBase {
  readonly _tag: "StateMachine"
  readonly maxTurns: number
}

export interface PlannedActionTempo extends TempoBase {
  readonly _tag: "PlannedAction"
  readonly maxCycles: number
  readonly breakDurationMs: number
  readonly breakPollIntervalSec: number
}

export type TempoConfig = StateMachineTempo | PlannedActionTempo
