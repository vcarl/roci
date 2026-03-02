import { Effect, Queue, Layer, Deferred } from "effect"
import type { CharacterConfig } from "../services/CharacterFs.js"
import type { GameState } from "../game/types.js"
import type { GameEvent } from "../game/ws-types.js"
import type { ExitReason } from "../core/types.js"
import type { LifecycleHooks } from "../core/lifecycle.js"
import { SkillRegistryTag } from "../core/skill.js"
import { SpaceMoltEventProcessorLive } from "../domains/spacemolt/event-processor.js"
import { SpaceMoltInterruptRegistryLive } from "../domains/spacemolt/interrupts.js"
import { SpaceMoltSituationClassifierLive } from "../domains/spacemolt/situation.js"
import { SpaceMoltStateRendererLive } from "../domains/spacemolt/renderer.js"
import { SpaceMoltPromptBuilderLive } from "../domains/spacemolt/prompt-builder.js"
import { SpaceMoltContextHandlerLive } from "../domains/spacemolt/context-handler.js"
import { runStateMachine } from "../core/state-machine.js"

/** No-op skill registry — all step completion falls through to the LLM evaluator. */
const StubSkillRegistryLive = Layer.succeed(SkillRegistryTag, {
  skills: [],
  getSkill: () => undefined,
  taskList: () => "",
  isStepComplete: () => ({
    complete: false,
    reason: "No skill registry configured",
    matchedCondition: null,
    relevantState: {},
  }),
})

export interface EventLoopConfig {
  char: CharacterConfig
  containerId: string
  playerName: string
  containerEnv?: Record<string, string>
  events: Queue.Queue<GameEvent>
  initialState: GameState
  tickIntervalSec: number
  /** Current game tick at connection time, for initializing tick tracking. */
  initialTick: number
  exitSignal?: Deferred.Deferred<ExitReason, never>
  hooks?: LifecycleHooks
}

/**
 * SpaceMolt event loop — provides all domain service layers,
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
    Effect.provide(
      Layer.mergeAll(
        SpaceMoltPromptBuilderLive,
        SpaceMoltEventProcessorLive,
        StubSkillRegistryLive,
        SpaceMoltInterruptRegistryLive,
        SpaceMoltSituationClassifierLive,
        SpaceMoltStateRendererLive,
        SpaceMoltContextHandlerLive,
      ),
    ),
  )
