import { Effect, Deferred, Queue } from "effect"
import type { GameState } from "./types.js"
import type { GameEvent } from "./ws-types.js"
import type { Phase, PhaseContext, PhaseResult, PhaseRegistry, ConnectionState } from "../../core/phase.js"
import type { ExitReason } from "../../core/types.js"
import type { LifecycleHooks } from "../../core/lifecycle.js"
import { CharacterFs } from "../../services/CharacterFs.js"
import { GameSocket } from "./game-socket.js"
import { dream } from "../../ai/dream.js"
import { dinner } from "../../ai/dinner.js"
import { eventLoop } from "../../monitor/event-loop.js"
import { spaceMoltDomainBundle } from "./index.js"
import { logToConsole } from "../../logging/console-renderer.js"
import { CharacterLog } from "../../logging/log-writer.js"

/** Ticks in the active game loop before transitioning to social phase. At 30s/tick, 100 ticks ~ 50 min. */
const ACTIVE_SESSION_TURNS = 100

/** Diary lines above this threshold trigger dream compression. */
const DIARY_COMPRESSION_THRESHOLD = 200

/** Internal connection type for SpaceMolt phases. */
type SMConnection = ConnectionState<GameState, GameEvent>

/**
 * Startup phase: connect to game, dream if diary is long.
 */
const startupPhase = {
  name: "startup",
  run: (context: PhaseContext) =>
    Effect.gen(function* () {
      const charFs = yield* CharacterFs
      const gameSocket = yield* GameSocket

      // Connect to the game
      const creds = yield* charFs.readCredentials(context.char)
      const { events, initialState, tickIntervalSec, initialTick } =
        yield* gameSocket.connect(creds, context.char.name)

      yield* logToConsole(
        context.char.name,
        "orchestrator",
        `Connected via WebSocket as ${initialState.player.username}`,
      )

      // Dream if diary is long
      const diary = yield* charFs.readDiary(context.char)
      const diaryLines = diary.split("\n").length
      if (diaryLines > DIARY_COMPRESSION_THRESHOLD) {
        yield* logToConsole(context.char.name, "orchestrator", `Diary is ${diaryLines} lines — dreaming...`)
        yield* dream.execute({ char: context.char }).pipe(
          Effect.catchAll((e) =>
            logToConsole(context.char.name, "orchestrator", `Dream failed: ${e}`),
          ),
        )
      }

      const connection: SMConnection = { events, initialState, tickIntervalSec, initialTick }
      return { _tag: "Continue", next: "active", connection } as PhaseResult
    }),
}

/**
 * Active gameplay phase: runs the event loop / state machine.
 * Exits after MIN_ACTIVE_TURNS turns (~50 minutes at 30s/tick),
 * then transitions to social phase.
 */
const activePhase = {
  name: "active",
  run: (context: PhaseContext) =>
    Effect.gen(function* () {
      const log = yield* CharacterLog

      if (!context.connection) {
        yield* logToConsole(context.char.name, "orchestrator", "No connection in active phase — shutting down")
        return { _tag: "Shutdown" } as PhaseResult
      }

      const conn = context.connection as SMConnection
      const { events, initialState, tickIntervalSec, initialTick } = conn

      yield* logToConsole(context.char.name, "orchestrator", "Starting event loop...")

      yield* log.action(context.char, {
        timestamp: new Date().toISOString(),
        source: "orchestrator",
        character: context.char.name,
        type: "loop_start",
        containerId: context.containerId,
      })

      const exitSignal = yield* Deferred.make<ExitReason, never>()

      const hooks: LifecycleHooks = {
        shouldExit: (turnCount: number) => Effect.succeed(turnCount >= ACTIVE_SESSION_TURNS),
      }

      yield* eventLoop({
        char: context.char,
        containerId: context.containerId,
        playerName: context.char.name,
        containerEnv: context.containerEnv,
        events: events as Queue.Queue<unknown>,
        initialState,
        tickIntervalSec,
        initialTick,
        exitSignal,
        hooks,
        domainBundle: spaceMoltDomainBundle,
      })

      // When the state machine exits, transition to social phase
      return { _tag: "Continue", next: "social", connection: context.connection } as PhaseResult
    }),
}

/**
 * Social/dinner phase: reflect on the session over dinner.
 */
const socialPhase = {
  name: "social",
  run: (context: PhaseContext) =>
    Effect.gen(function* () {
      yield* logToConsole(context.char.name, "orchestrator", "Dinner time — reflecting on the session...")

      yield* dinner.execute({ char: context.char }).pipe(
        Effect.catchAll((e) =>
          logToConsole(context.char.name, "orchestrator", `Dinner failed: ${e}`),
        ),
      )

      return { _tag: "Continue", next: "reflection", connection: context.connection } as PhaseResult
    }),
}

/**
 * Reflection phase: dream to compress diary, then loop back to active.
 */
const reflectionPhase = {
  name: "reflection",
  run: (context: PhaseContext) =>
    Effect.gen(function* () {
      const charFs = yield* CharacterFs

      const diary = yield* charFs.readDiary(context.char)
      const diaryLines = diary.split("\n").length
      if (diaryLines > DIARY_COMPRESSION_THRESHOLD) {
        yield* logToConsole(context.char.name, "orchestrator", `Diary is ${diaryLines} lines — dreaming...`)
        yield* dream.execute({ char: context.char }).pipe(
          Effect.catchAll((e) =>
            logToConsole(context.char.name, "orchestrator", `Dream failed: ${e}`),
          ),
        )
      }

      return { _tag: "Continue", next: "active", connection: context.connection } as PhaseResult
    }),
}

const allPhases = [
  startupPhase as unknown as Phase,
  activePhase as unknown as Phase,
  socialPhase as unknown as Phase,
  reflectionPhase as unknown as Phase,
] as const

export const spaceMoltPhaseRegistry: PhaseRegistry = {
  phases: allPhases,
  getPhase: (name: string) => allPhases.find((p) => p.name === name),
  initialPhase: "startup",
}
