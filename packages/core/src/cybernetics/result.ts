import type { TurnResult } from "../core/limbic/hypothalamus/types.js"
import type { DelegationResult } from "./types.js"

/** Map a completed (or timed-out) turn to a delegation result. */
export function toDelegationResult(turn: TurnResult): DelegationResult {
  return {
    status: turn.timedOut ? "timed_out" : "completed",
    output: turn.output,
    durationMs: turn.durationMs,
  }
}
