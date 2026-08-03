import { Effect, Queue } from "effect"
import { FileSystem } from "@effect/platform"
import * as path from "node:path"
import type { GameState } from "./types.js"
import type { GameEvent } from "./game-events.js"
import { getModels, type Phase, type PhaseContext, type PhaseResult, type PhaseRegistry, type ConnectionState } from "@roci/core/core/phase.js"
import { GameSocket } from "./game-socket.js"
import { runReflection } from "@roci/core/core/orchestrator/planned-action.js"
import { runActivation } from "@roci/core/brain/stem/loop.js"
import { CharacterLog, logToConsole } from "@roci/core/logging/log-writer.js"
import { meDir } from "@roci/core/services/character-paths.js"
import { eventBase } from "@roci/core/logging/events.js"
import { registerCharacter, deriveUsername, pickEmpire } from "./register.js"
import { sessionFilePath, validateSessionFile } from "./session.js"
import { askUser } from "@roci/core/util/prompt.js"

/** Internal connection type for SpaceMolt phases. */
type SMConnection = ConnectionState<GameState, GameEvent>

/**
 * Startup phase: connect to game, dream if diary is long.
 */
const startupPhase = {
  name: "startup",
  run: (context: PhaseContext) =>
    Effect.gen(function* () {
      const gameSocket = yield* GameSocket

      // Auth source of truth: the per-player .spacemolt-session.json. Compute
      // projectRoot from char.root (<root>/players/<name>).
      const projectRoot = path.resolve(context.char.root, "..", "..")
      const sessionPath = sessionFilePath(projectRoot, context.char.name)
      const sessionCheck = validateSessionFile(sessionPath)

      if (!sessionCheck.ok) {
        // No valid session file — register via a registration code.
        const fs = yield* FileSystem.FileSystem
        const regCodePath = path.join(meDir(context.char), "registration-code.txt")
        const regCodeExists = yield* fs.exists(regCodePath).pipe(
          Effect.catchAll(() => Effect.succeed(false)),
        )

        // Read existing registration code, or prompt for one
        let registrationCode: string | undefined

        if (regCodeExists) {
          registrationCode = yield* fs.readFileString(regCodePath).pipe(
            Effect.map((s) => s.trim()),
            Effect.catchAll(() => Effect.succeed("")),
          )
        }

        if (!registrationCode) {
          // Prompt the user inline — this blocks this character's fiber only
          const code = yield* askUser(
            `[${context.char.name}] Enter SpaceMolt registration code (from spacemolt.com/dashboard): `,
          )
          registrationCode = code?.trim()

          if (!registrationCode) {
            yield* logToConsole(
              context.char.name,
              "orchestrator",
              "No registration code provided — skipping registration",
            )
            return { _tag: "Shutdown" } as PhaseResult
          }

          // Save for future runs
          yield* fs.writeFileString(regCodePath, registrationCode + "\n")
        }

        if (!registrationCode) {
          yield* logToConsole(
            context.char.name,
            "orchestrator",
            "registration-code.txt is empty. Get a code from spacemolt.com/dashboard.",
          )
          return { _tag: "Shutdown" } as PhaseResult
        }

        const username = deriveUsername(context.char.name)
        const empire = pickEmpire(context.char.name)

        yield* logToConsole(
          context.char.name,
          "orchestrator",
          `No session file (${sessionCheck.reason}) — registering as "${username}" in ${empire} empire...`,
        )

        const regResult = yield* registerCharacter(context.char, registrationCode).pipe(
          Effect.catchAll((e) => {
            return logToConsole(
              context.char.name,
              "orchestrator",
              `Registration failed: ${e.message}`,
            ).pipe(Effect.flatMap(() => Effect.fail(e)))
          }),
        )

        yield* logToConsole(
          context.char.name,
          "orchestrator",
          `Registered successfully as ${regResult.username} (player_id: ${regResult.playerId}) — wrote session file`,
        )

        const { events, initialState, tickIntervalSec, initialTick } =
          yield* gameSocket.connect(context.char)

        yield* logToConsole(
          context.char.name,
          "orchestrator",
          `Connected via WebSocket as ${initialState.player.username}`,
        )

        yield* runReflection(context.char, context.containerId, getModels(context), context.containerAddDirs, context.containerEnv)

        const connection: SMConnection = { events, initialState, tickIntervalSec, initialTick }
        return { _tag: "Continue", next: "active", connection } as PhaseResult
      }

      // Valid session file — connect to the game
      const { events, initialState, tickIntervalSec, initialTick } =
        yield* gameSocket.connect(context.char)

      yield* logToConsole(
        context.char.name,
        "orchestrator",
        `Connected via WebSocket as ${initialState.player.username}`,
      )

      yield* runReflection(context.char, context.containerId, getModels(context), context.containerAddDirs, context.containerEnv)

      const connection: SMConnection = { events, initialState, tickIntervalSec, initialTick }
      return { _tag: "Continue", next: "active", connection } as PhaseResult
    }),
}

/**
 * Active gameplay phase: runs a persistent channel session.
 * Exits when the session completes naturally (transitions to social)
 * or is interrupted by a critical interrupt (re-enters active).
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
      const { events, initialState } = conn

      yield* logToConsole(context.char.name, "orchestrator", "Starting event loop...")

      yield* log.emit(context.char, {
        ...eventBase(context.char.name, "orchestrator", "activation-loop"),
        kind: "system",
        message: "loop_start",
      })

      if (!context.domainBundle) {
        yield* logToConsole(context.char.name, "orchestrator", "No domainBundle in active phase — shutting down")
        return { _tag: "Shutdown" } as PhaseResult
      }

      const result = yield* runActivation({
        char: context.char,
        containerId: context.containerId,
        containerEnv: context.containerEnv,
        addDirs: context.containerAddDirs,
        events: events as Queue.Queue<unknown>,
        initialState,
        cadence: "real-time",
        workerModels: getModels(context),
        orientInterval: 3,
        tickIntervalMs: conn.tickIntervalSec * 1000,
      }).pipe(Effect.provide(context.domainBundle!))

      if (result._tag === "Interrupted") {
        // Clear `deathPending` here: consuming the phase exit IS the
        // acknowledgement of the death that caused it. Without this the
        // amygdala rule's level condition would still hold on the restarted
        // `active` phase and fire again immediately, ping-ponging the character
        // through the phase machine forever.
        const finalState = { ...(result.finalState as GameState), deathPending: false }
        return { _tag: "Continue", next: "active", connection: { ...conn, initialState: finalState } } as PhaseResult
      }
      return { _tag: "Continue", next: "social", connection: { ...conn, initialState: result.finalState } } as PhaseResult
    }),
}

/**
 * Social phase: a quiet boundary at the end of a session before reflection.
 * The diary rewrite that used to live here (dinner) is now the domain-agnostic
 * consolidate pass run inside runReflection.
 */
const socialPhase = {
  name: "social",
  run: (context: PhaseContext) =>
    Effect.gen(function* () {
      yield* logToConsole(context.char.name, "orchestrator", "Session complete — winding down before reflection...")
      return { _tag: "Continue", next: "reflection", connection: context.connection } as PhaseResult
    }),
}

/**
 * Reflection phase: consolidate then cull the diary, then loop back to active.
 */
const reflectionPhase = {
  name: "reflection",
  run: (context: PhaseContext) =>
    Effect.gen(function* () {
      yield* runReflection(context.char, context.containerId, getModels(context), context.containerAddDirs, context.containerEnv)
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
