import { Context } from "effect"
import type { DomainState, DomainEvent } from "../../domain-types.js"

export interface DomainContext {
  readonly chatMessages?: ReadonlyArray<{
    readonly channel: string
    readonly sender: string
    readonly content: string
  }>
}

export type EventCategory =
  | { readonly _tag: "Heartbeat"; readonly tick: number }
  | { readonly _tag: "StateChange" }
  | { readonly _tag: "LifecycleReset"; readonly reason: string }

/**
 * Translates raw domain events into state machine operations.
 */
export interface EventProcessor {
  /** Process a single event, returning how the state machine should react. */
  processEvent(event: DomainEvent, currentState: DomainState): EventResult
}

export interface EventResult {
  readonly category?: EventCategory
  readonly stateUpdate?: (prev: DomainState) => DomainState
  readonly context?: DomainContext
  readonly log?: () => void
  /** Immediate alert text to push to the running session via channel. */
  readonly alert?: string
}

/**
 * Effect service tag for the event processor.
 */
export class EventProcessorTag extends Context.Tag("EventProcessor")<
  EventProcessorTag,
  EventProcessor
>() {}
