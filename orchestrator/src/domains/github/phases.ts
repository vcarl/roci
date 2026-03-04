import { Effect, Deferred, Queue } from "effect"
import type { RepoState, GitHubEvent } from "./types.js"
import type { Phase, PhaseContext, PhaseResult, PhaseRegistry, ConnectionState } from "../../core/phase.js"
import type { ExitReason } from "../../core/types.js"
import type { LifecycleHooks } from "../../core/lifecycle.js"
import { CharacterFs } from "../../services/CharacterFs.js"
import { GitHubClientTag, type GitHubClientConfig } from "./github-client.js"
import { eventLoop } from "../../monitor/event-loop.js"
import { logToConsole } from "../../logging/console-renderer.js"
import { CharacterLog } from "../../logging/log-writer.js"

/** Ticks in the active loop before exiting. At 30s/tick, 100 ticks ~ 50 min. */
const ACTIVE_SESSION_TURNS = 100

/** Default poll interval for GitHub API (30 seconds). */
const DEFAULT_POLL_INTERVAL_MS = 30_000

type GHConnection = ConnectionState<RepoState, GitHubEvent>

/**
 * Startup phase: read config, connect to GitHub, build initial state.
 */
const startupPhase = {
  name: "startup",
  run: (context: PhaseContext) =>
    Effect.gen(function* () {
      const charFs = yield* CharacterFs
      const ghClient = yield* GitHubClientTag

      // Read owner/repo from credentials.txt (format: "Username: owner/repo")
      const creds = yield* charFs.readCredentials(context.char)
      const [owner, repo] = creds.username.split("/")

      yield* logToConsole(
        context.char.name,
        "orchestrator",
        `Connecting to GitHub: ${owner}/${repo}`,
      )

      const config: GitHubClientConfig = {
        owner,
        repo,
        pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
        token: creds.password,
      }

      const { events, initialState, tickIntervalSec, initialTick } =
        yield* ghClient.connect(config)

      yield* logToConsole(
        context.char.name,
        "orchestrator",
        `Connected to ${owner}/${repo}`,
      )

      const connection: GHConnection = { events, initialState, tickIntervalSec, initialTick }
      return { _tag: "Continue", next: "active", connection } as PhaseResult
    }),
}

/**
 * Active phase: run the event loop with the domain bundle.
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

      const conn = context.connection as GHConnection
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

      if (!context.domainBundle) {
        yield* logToConsole(context.char.name, "orchestrator", "No domainBundle in active phase — shutting down")
        return { _tag: "Shutdown" } as PhaseResult
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
        domainBundle: context.domainBundle,
      })

      return { _tag: "Shutdown" } as PhaseResult
    }),
}

const allPhases = [
  startupPhase as unknown as Phase,
  activePhase as unknown as Phase,
] as const

export const gitHubPhaseRegistry: PhaseRegistry = {
  phases: allPhases,
  getPhase: (name: string) => allPhases.find((p) => p.name === name),
  initialPhase: "startup",
}
