import { Context } from "effect"
import type { DomainState, DomainEvent } from "./domain-types.js"

/**
 * Translates raw domain events into state machine operations.
 */
export interface EventProcessor {
  /** Process a single event, returning how the state machine should react. */
  processEvent(event: DomainEvent, currentState: DomainState): EventResult
}

export interface EventResult {
  /** Merge into state. If undefined, state is unchanged. */
  stateUpdate?: (prev: DomainState) => DomainState
  /** Update tick counter. If undefined, tick is unchanged. */
  tick?: number
  /** Trigger interrupt processing (check for critical alerts). */
  isInterrupt?: boolean
  /** Kill everything and start fresh (e.g. death). */
  isReset?: boolean
  /** Flag indicating this is a full state update (triggers plan/spawn cycle). */
  isStateUpdate?: boolean
  /** Flag indicating this is a tick heartbeat (triggers mid-run checks + plan/spawn). */
  isTick?: boolean
  /** Accumulated context data (e.g. chat messages). Keyed by context type. */
  accumulatedContext?: Record<string, unknown>
  /** Logging side effect — called after state is updated. */
  log?: () => void
}

/**
 * Effect service tag for the event processor.
 */
export class EventProcessorTag extends Context.Tag("EventProcessor")<
  EventProcessorTag,
  EventProcessor
>() {}
