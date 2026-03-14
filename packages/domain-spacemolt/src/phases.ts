import { Effect, Deferred, Queue } from "effect"
import { FileSystem } from "@effect/platform"
import * as path from "node:path"
import type { GameState } from "./types.js"
import type { GameEvent } from "./ws-types.js"
import type { Phase, PhaseContext, PhaseResult, PhaseRegistry, ConnectionState } from "@signal/core/core/phase.js"
import type { ExitReason } from "@signal/core/core/types.js"
import type { LifecycleHooks } from "@signal/core/core/orchestrator/lifecycle.js"
import { CharacterFs } from "@signal/core/services/CharacterFs.js"
import { GameSocket } from "./game-socket.js"
import { runReflection } from "@signal/core/core/orchestrator/planned-action.js"
import { dinner } from "./dinner.js"
import { runStateMachine } from "@signal/core/core/orchestrator/state-machine.js"
import { logToConsole } from "@signal/core/logging/console-renderer.js"
import { CharacterLog } from "@signal/core/logging/log-writer.js"
import { registerCharacter, deriveUsername, pickEmpire } from "./register.js"
import { askUser } from "@signal/core/util/prompt.js"
import { reportStatus } from "@signal/core/server/status-reporter.js"
import { readTodo } from "@signal/core/operator/todo-reader.js"
import { readWindDown } from "@signal/core/operator/wind-down-file.js"

/** Active session wall-clock duration before transitioning to social phase. */
const ACTIVE_SESSION_DURATION_MS = 50 * 60 * 1000 // 50 minutes

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

      // Try to read credentials — if missing, the character needs to register first
      const credsResult = yield* charFs.readCredentials(context.char).pipe(
        Effect.map((creds) => ({ _tag: "ok" as const, creds })),
        Effect.catchAll(() => Effect.succeed({ _tag: "missing" as const, creds: null })),
      )

      if (credsResult._tag === "missing") {
        // Try to auto-register using a registration code
        const fs = yield* FileSystem.FileSystem
        const regCodePath = path.join(context.char.dir, "registration-code.txt")
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
          `No credentials found — registering as "${username}" in ${empire} empire...`,
        )

        const regResult = yield* registerCharacter(username, empire, registrationCode).pipe(
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
          `Registered successfully as ${regResult.username} (player_id: ${regResult.playerId})`,
        )

        // Write credentials.txt
        const credsContent = `Username: ${regResult.username}\nPassword: ${regResult.password}\n`
        const credsPath = path.join(context.char.dir, "credentials.txt")
        yield* fs.writeFileString(credsPath, credsContent).pipe(
          Effect.catchAll((e) => {
            return logToConsole(
              context.char.name,
              "orchestrator",
              `Failed to write credentials.txt: ${e}`,
            ).pipe(Effect.flatMap(() => Effect.fail(e)))
          }),
        )

        yield* logToConsole(
          context.char.name,
          "orchestrator",
          "Saved credentials.txt — proceeding with normal login",
        )

        // Now read credentials and continue with normal login flow
        const creds = yield* charFs.readCredentials(context.char)

        const { events, initialState, tickIntervalSec, initialTick } =
          yield* gameSocket.connect(creds, context.char.name)

        yield* logToConsole(
          context.char.name,
          "orchestrator",
          `Connected via WebSocket as ${initialState.player.username}`,
        )

        yield* runReflection(context.char, DIARY_COMPRESSION_THRESHOLD)

        const connection: SMConnection = { events, initialState, tickIntervalSec, initialTick }
        return { _tag: "Continue", next: "active", connection } as PhaseResult
      }

      // Connect to the game
      const { events, initialState, tickIntervalSec, initialTick } =
        yield* gameSocket.connect(credsResult.creds, context.char.name)

      yield* logToConsole(
        context.char.name,
        "orchestrator",
        `Connected via WebSocket as ${initialState.player.username}`,
      )

      // Dream if diary is long
      yield* runReflection(context.char, DIARY_COMPRESSION_THRESHOLD)

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

      // If a wind-down signal is still active (from a previous session), exit cleanly.
      // Nonstop mode in orchestrator.ts will clear it and restart after the session resets.
      const playersDir = path.resolve(context.char.dir, "..", "..")
      const existingWindDown = yield* Effect.sync(() => readWindDown(playersDir))
      if (existingWindDown) {
        yield* logToConsole(context.char.name, "orchestrator", `Wind-down still active (${existingWindDown.reason}) — returning Shutdown for nonstop wait`)
        return { _tag: "Shutdown" } as PhaseResult
      }

      yield* logToConsole(context.char.name, "orchestrator", "Starting event loop...")

      yield* log.action(context.char, {
        timestamp: new Date().toISOString(),
        source: "orchestrator",
        character: context.char.name,
        type: "loop_start",
        containerId: context.containerId,
      })

      const sessionStartMs = Date.now()
      const exitSignal = yield* Deferred.make<ExitReason, never>()

      const hooks: LifecycleHooks = {
        shouldExit: (_turnCount: number) => Effect.succeed(Date.now() - sessionStartMs >= ACTIVE_SESSION_DURATION_MS),
      }

      if (!context.domainBundle) {
        yield* logToConsole(context.char.name, "orchestrator", "No domainBundle in active phase — shutting down")
        return { _tag: "Shutdown" } as PhaseResult
      }

      const manualApproval = context.phaseData?.manualApproval as boolean | undefined

      // Status reporter: write players/{name}/status.json on each tick for Overlord monitoring
      const playerDir = path.resolve(context.char.dir, "..")
      // playersDir already declared above (used for wind-down check)

      // TODO.md directive injection: read before each brain plan
      const hooksWithTodo: LifecycleHooks = {
        ...hooks,
        beforePlan: (_ctx) =>
          Effect.sync(() => {
            const todo = readTodo(playerDir)
            if (!todo) return {}
            return {
              additionalContext: `## Operator Directives (${todo.filePath})\n${todo.content}\n\nYou may self-update this file using the Edit tool when directives are complete.`,
            }
          }),
      }

      yield* runStateMachine({
        char: context.char,
        containerId: context.containerId,
        playerName: context.char.name,
        containerEnv: context.containerEnv,
        addDirs: context.containerAddDirs,
        events: events as Queue.Queue<unknown>,
        initialState,
        tickIntervalSec,
        initialTick,
        exitSignal,
        hooks: hooksWithTodo,
        manualApproval,
        onStatusUpdate: (snapshot) => reportStatus(playersDir, context.char.name.toLowerCase(), snapshot),
        prayerBaseUrl: process.env.PRAYER_BASE_URL,
      }).pipe(Effect.provide(context.domainBundle))

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
      yield* runReflection(context.char, DIARY_COMPRESSION_THRESHOLD)
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
