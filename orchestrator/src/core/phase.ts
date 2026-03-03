import { Context, Effect, Queue } from "effect"
import type { CharacterConfig } from "../services/CharacterFs.js"
import type { DomainBundle } from "./domain-bundle.js"

/**
 * Connection state threaded between phases.
 * Carries the live WebSocket event queue and initial state from connect.
 */
export interface ConnectionState<S = unknown, Evt = unknown> {
  readonly events: Queue.Queue<Evt>
  readonly initialState: S
  readonly tickIntervalSec: number
  readonly initialTick: number
}

/**
 * Context available to every phase.
 */
export interface PhaseContext<S = unknown, Evt = unknown> {
  readonly char: CharacterConfig
  readonly containerId: string
  readonly containerEnv?: Record<string, string>
  /** Connection state — available after the startup phase connects. */
  readonly connection?: ConnectionState<S, Evt>
  /** Arbitrary data threaded between phases. */
  readonly phaseData?: Record<string, unknown>
  /** Domain service layers for the state machine. */
  readonly domainBundle?: DomainBundle
}

/**
 * Result of running a phase — determines what happens next.
 */
export type PhaseResult<S = unknown, Evt = unknown> =
  | {
      readonly _tag: "Continue"
      readonly next: string
      readonly connection?: ConnectionState<S, Evt>
      readonly data?: Record<string, unknown>
    }
  | { readonly _tag: "Restart" }
  | { readonly _tag: "Shutdown" }

/**
 * A single phase in the session lifecycle.
 * R captures the Effect service requirements so they propagate through the type system.
 */
export interface Phase<S = unknown, Evt = unknown, R = never> {
  readonly name: string
  readonly run: (context: PhaseContext<S, Evt>) => Effect.Effect<PhaseResult<S, Evt>, unknown, R>
}

/**
 * Registry of available phases.
 * R is the union of all phases' service requirements.
 */
export interface PhaseRegistry<S = unknown, Evt = unknown, R = never> {
  readonly phases: ReadonlyArray<Phase<S, Evt, R>>
  readonly getPhase: (name: string) => Phase<S, Evt, R> | undefined
  readonly initialPhase: string
}

export class PhaseRegistryTag extends Context.Tag("PhaseRegistry")<
  PhaseRegistryTag,
  PhaseRegistry
>() {}
