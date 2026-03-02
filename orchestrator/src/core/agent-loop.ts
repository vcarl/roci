import { Effect, Queue } from "effect"
import type { CharacterConfig } from "../services/CharacterFs.js"
import { CharacterLog } from "../logging/log-writer.js"
import { logToConsole } from "../logging/console-renderer.js"
import { runStateMachine } from "./state-machine.js"
import type { GameState } from "../game/types.js"
import type { GameEvent } from "../game/ws-types.js"

export interface AgentLoopConfig {
  char: CharacterConfig
  containerId: string
  containerEnv?: Record<string, string>
  /** Domain-specific connection function that returns events + initial state. */
  connect: () => Effect.Effect<{
    events: Queue.Queue<GameEvent>
    initialState: GameState
    tickIntervalSec: number
    initialTick: number
  }, unknown, never>
  /** Optional startup hook (e.g. dream/memory compression). */
  onStartup?: () => Effect.Effect<void, unknown, never>
  /** Optional shutdown hook (e.g. dinner/reflection). */
  onShutdown?: () => Effect.Effect<void, unknown, never>
}

/**
 * Per-agent lifecycle:
 * 1. Connect to domain via the provided connect function
 * 2. Run optional startup hook (e.g. dream)
 * 3. Run the state machine event loop
 */
export const agentLoop = (config: AgentLoopConfig) =>
  Effect.scoped(
    Effect.gen(function* () {
      const log = yield* CharacterLog

      yield* logToConsole(config.char.name, "orchestrator", "Starting agent loop...")

      // 1. Connect
      const { events, initialState, tickIntervalSec, initialTick } = yield* config.connect()
      yield* logToConsole(config.char.name, "orchestrator", "Connected to domain")

      // 2. Startup hook
      if (config.onStartup) {
        yield* config.onStartup().pipe(
          Effect.catchAll((e) =>
            logToConsole(config.char.name, "orchestrator", `Startup hook failed: ${e}`),
          ),
        )
      }

      // 3. Run the state machine
      yield* logToConsole(config.char.name, "orchestrator", "Starting event loop...")

      yield* log.action(config.char, {
        timestamp: new Date().toISOString(),
        source: "orchestrator",
        character: config.char.name,
        type: "loop_start",
        containerId: config.containerId,
      })

      yield* runStateMachine({
        char: config.char,
        containerId: config.containerId,
        playerName: config.char.name,
        containerEnv: config.containerEnv,
        events,
        initialState,
        tickIntervalSec,
        initialTick,
      })
    }),
  )
