import { Context } from "effect"
import type { DomainState } from "./domain-types.js"

/**
 * All state-to-human-readable transformations.
 * Used by brain functions for prompt context and by the state machine
 * for logging/diffs.
 */
export interface StateRenderer {
  /** Rich snapshot (includes breakdown data + tick) for diff tracking. */
  richSnapshot(state: DomainState): Record<string, unknown>
  /** Human-readable diff between two rich snapshots. */
  stateDiff(before: Record<string, unknown> | null, after: Record<string, unknown>): string
  /** Compact console output line per tick. Returns the metric body string (no name prefix); empty string when there are no parts. */
  formatStateBar(metrics: Record<string, string | number | boolean>): string
}

/**
 * Effect service tag for the state renderer.
 */
export class StateRendererTag extends Context.Tag("StateRenderer")<StateRendererTag, StateRenderer>() {}
