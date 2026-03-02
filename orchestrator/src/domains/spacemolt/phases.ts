import { Effect, Deferred } from "effect"
import type { GameState } from "../../../../harness/src/types.js"
import type { GameEvent } from "../../../../harness/src/ws-types.js"
import type { Phase, PhaseContext, PhaseResult, PhaseRegistry, ConnectionState } from "../../core/phase.js"
import type { ExitReason } from "../../core/types.js"
import type { LifecycleHooks } from "../../core/lifecycle.js"
import { CharacterFs } from "../../services/CharacterFs.js"
import { GameSocket } from "../../services/GameSocket.js"
import { dream } from "../../ai/dream.js"
import { dinner } from "../../ai/dinner.js"
import { eventLoop } from "../../monitor/event-loop.js"
import { logToConsole } from "../../logging/console-renderer.js"
import { CharacterLog } from "../../logging/log-writer.js"

type SMPhaseContext = PhaseContext<GameState, GameEvent>
type SMPhaseResult = PhaseResult<GameState, GameEvent>
type SMConnectionState = ConnectionState<GameState, GameEvent>

/**
 * Helper to create a properly typed phase.
 */
function definePhase<R>(
  name: string,
  run: (context: SMPhaseContext) => Effect.Effect<SMPhaseResult, unknown, R>,
): Phase<GameState, GameEvent, R> {
  return { name, run }
}

/**
 * Startup phase: connect to game, dream if diary is long.
 */
const startupPhase = definePhase("startup", (context) =>
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
    if (diaryLines > 200) {
      yield* logToConsole(context.char.name, "orchestrator", `Diary is ${diaryLines} lines — dreaming...`)
      yield* dream.execute({ char: context.char }).pipe(
        Effect.catchAll((e) =>
          logToConsole(context.char.name, "orchestrator", `Dream failed: ${e}`),
        ),
      )
    }

    const connection: SMConnectionState = { events, initialState, tickIntervalSec, initialTick }
    return { _tag: "Continue", next: "active", connection } as SMPhaseResult
  }),
)

/**
 * Active gameplay phase: runs the event loop / state machine.
 * Exits after MIN_ACTIVE_TURNS turns (~50 minutes at 30s/tick),
 * then transitions to social phase.
 */
const MIN_ACTIVE_TURNS = 100

const activePhase = definePhase("active", (context) =>
  Effect.gen(function* () {
    const log = yield* CharacterLog

    if (!context.connection) {
      yield* logToConsole(context.char.name, "orchestrator", "No connection in active phase — shutting down")
      return { _tag: "Shutdown" } as SMPhaseResult
    }

    const { events, initialState, tickIntervalSec, initialTick } = context.connection

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
      shouldExit: (turnCount: number) => Effect.succeed(turnCount >= MIN_ACTIVE_TURNS),
    }

    yield* eventLoop({
      char: context.char,
      containerId: context.containerId,
      playerName: context.char.name,
      projectRoot: context.projectRoot,
      containerEnv: context.containerEnv,
      events,
      initialState,
      tickIntervalSec,
      initialTick,
      exitSignal,
      hooks,
    })

    // When the state machine exits, transition to social phase
    return { _tag: "Continue", next: "social", connection: context.connection } as SMPhaseResult
  }),
)

/**
 * Social/dinner phase: reflect on the session over dinner.
 */
const socialPhase = definePhase("social", (context) =>
  Effect.gen(function* () {
    yield* logToConsole(context.char.name, "orchestrator", "Dinner time — reflecting on the session...")

    yield* dinner.execute({ char: context.char, projectRoot: context.projectRoot }).pipe(
      Effect.catchAll((e) =>
        logToConsole(context.char.name, "orchestrator", `Dinner failed: ${e}`),
      ),
    )

    return { _tag: "Continue", next: "reflection", connection: context.connection } as SMPhaseResult
  }),
)

/**
 * Reflection phase: dream to compress diary, then loop back to active.
 */
const reflectionPhase = definePhase("reflection", (context) =>
  Effect.gen(function* () {
    const charFs = yield* CharacterFs

    const diary = yield* charFs.readDiary(context.char)
    const diaryLines = diary.split("\n").length
    if (diaryLines > 200) {
      yield* logToConsole(context.char.name, "orchestrator", `Diary is ${diaryLines} lines — dreaming...`)
      yield* dream.execute({ char: context.char }).pipe(
        Effect.catchAll((e) =>
          logToConsole(context.char.name, "orchestrator", `Dream failed: ${e}`),
        ),
      )
    }

    return { _tag: "Continue", next: "active", connection: context.connection } as SMPhaseResult
  }),
)

/** Union of all service requirements across all SpaceMolt phases. */
type SpaceMoltPhaseR =
  | typeof startupPhase extends Phase<any, any, infer R> ? R : never
  | typeof activePhase extends Phase<any, any, infer R> ? R : never
  | typeof socialPhase extends Phase<any, any, infer R> ? R : never
  | typeof reflectionPhase extends Phase<any, any, infer R> ? R : never

const allPhases = [
  startupPhase as Phase<GameState, GameEvent, SpaceMoltPhaseR>,
  activePhase as Phase<GameState, GameEvent, SpaceMoltPhaseR>,
  socialPhase as Phase<GameState, GameEvent, SpaceMoltPhaseR>,
  reflectionPhase as Phase<GameState, GameEvent, SpaceMoltPhaseR>,
] as const

export const spaceMoltPhaseRegistry: PhaseRegistry<GameState, GameEvent, SpaceMoltPhaseR> = {
  phases: allPhases,
  getPhase: (name: string) => allPhases.find((p) => p.name === name),
  initialPhase: "startup",
}
