import { Effect, Queue, Deferred } from "effect"
import type { CharacterConfig } from "../services/CharacterFs.js"
import type { DomainState, DomainEvent } from "../core/domain-types.js"
import type { DomainBundle } from "../core/domain-bundle.js"
import type { ExitReason } from "../core/types.js"
import type { LifecycleHooks } from "../core/lifecycle.js"
import { runStateMachine } from "../core/state-machine.js"

export interface EventLoopConfig {
  char: CharacterConfig
  containerId: string
  playerName: string
  containerEnv?: Record<string, string>
  events: Queue.Queue<DomainEvent>
  initialState: DomainState
  tickIntervalSec: number
  /** Current game tick at connection time, for initializing tick tracking. */
  initialTick: number
  exitSignal?: Deferred.Deferred<ExitReason, never>
  hooks?: LifecycleHooks
  /** Domain service layers for the state machine. */
  domainBundle: DomainBundle
}

/**
 * Domain-agnostic event loop — provides domain service layers,
 * then delegates to the generic state machine.
 */
export const eventLoop = (config: EventLoopConfig) =>
  runStateMachine({
    char: config.char,
    containerId: config.containerId,
    playerName: config.playerName,
    containerEnv: config.containerEnv,
    events: config.events,
    initialState: config.initialState,
    tickIntervalSec: config.tickIntervalSec,
    initialTick: config.initialTick,
    exitSignal: config.exitSignal,
    hooks: config.hooks,
  }).pipe(
    Effect.provide(config.domainBundle),
  )
