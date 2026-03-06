import { Effect, Deferred, Queue } from "effect"
import { FileSystem } from "@effect/platform"
import type { GitHubState, GitHubEvent, GitHubCharacterConfig } from "./types.js"
import type { Phase, PhaseContext, PhaseResult, PhaseRegistry, ConnectionState } from "../../core/phase.js"
import type { ExitReason } from "../../core/types.js"
import type { LifecycleHooks } from "../../core/lifecycle.js"
import { Docker } from "../../services/Docker.js"
import { GitHubClientTag, type GitHubClientConfig } from "./github-client.js"
import { eventLoop } from "../../monitor/event-loop.js"
import { logToConsole } from "../../logging/console-renderer.js"
import { CharacterLog } from "../../logging/log-writer.js"

/** Ticks in the active loop before exiting. At 30s/tick, 100 ticks ~ 50 min. */
const ACTIVE_SESSION_TURNS = 100

/** Default poll interval for GitHub API (30 seconds). */
const DEFAULT_POLL_INTERVAL_MS = 30_000

type GHConnection = ConnectionState<GitHubState, GitHubEvent>

/** Shared clone path inside the container. All characters share this. */
function sharedClonePath(owner: string, repo: string): string {
  return `/work/repos/${owner}--${repo}`
}

/** Per-character worktree base path for a specific repo. */
function worktreeBasePath(characterName: string, owner: string, repo: string): string {
  return `/work/players/${characterName}/worktrees/${owner}--${repo}`
}

/** Read github.json from the character's me/ directory. */
const readGitHubConfig = (charDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const configPath = `${charDir}/github.json`
    const content = yield* fs.readFileString(configPath).pipe(
      Effect.mapError((e) => new Error(`Failed to read github.json at ${configPath}: ${e}`)),
    )
    const parsed = JSON.parse(content) as GitHubCharacterConfig
    if (!parsed.token) {
      return yield* Effect.fail(new Error("github.json missing 'token' field"))
    }
    if (!parsed.repos || parsed.repos.length === 0) {
      return yield* Effect.fail(new Error("github.json missing or empty 'repos' array"))
    }
    return parsed
  })

/**
 * Ensure the shared clone exists (idempotent).
 * If already cloned, fetches latest. Shared across all characters in the container.
 */
const ensureSharedClone = (
  containerId: string,
  owner: string,
  repo: string,
  token: string,
) =>
  Effect.gen(function* () {
    const docker = yield* Docker
    const cloneDir = sharedClonePath(owner, repo)

    // Check if already cloned
    const exists = yield* docker.exec(containerId, [
      "sh", "-c", `test -d "${cloneDir}/.git" && echo "yes" || echo "no"`,
    ])

    if (exists.trim() === "yes") {
      yield* docker.exec(containerId, [
        "git", "-C", cloneDir, "fetch", "--all",
      ]).pipe(Effect.catchAll((e) => Effect.logWarning(`git fetch failed for ${owner}/${repo}: ${e}`)))
      yield* Effect.logInfo(`Shared clone exists at ${cloneDir}, fetched latest`)
      return cloneDir
    }

    // Create /work/repos if needed
    yield* docker.exec(containerId, ["mkdir", "-p", "/work/repos"])

    // Clone
    const cloneUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`
    yield* docker.exec(containerId, ["git", "clone", cloneUrl, cloneDir])

    yield* Effect.logInfo(`Cloned ${owner}/${repo} to ${cloneDir}`)
    return cloneDir
  })

/**
 * Ensure the character's worktree directory exists for a repo.
 * Does NOT create a worktree — the agent does that when starting a task.
 * Just sets up the directory and git identity config.
 */
const ensureWorktreeDir = (
  containerId: string,
  characterName: string,
  owner: string,
  repo: string,
) =>
  Effect.gen(function* () {
    const docker = yield* Docker
    const wtBase = worktreeBasePath(characterName, owner, repo)

    yield* docker.exec(containerId, ["mkdir", "-p", wtBase])

    // Git identity on the shared clone: all commits are authored by Claude.
    // Characters sign off in the commit message body instead.
    const cloneDir = sharedClonePath(owner, repo)
    yield* docker.exec(containerId, [
      "git", "-C", cloneDir, "config", "user.name", "Claude",
    ]).pipe(Effect.catchAll(() => Effect.void))
    yield* docker.exec(containerId, [
      "git", "-C", cloneDir, "config", "user.email", "noreply@anthropic.com",
    ]).pipe(Effect.catchAll(() => Effect.void))

    return wtBase
  })

/**
 * Startup phase: read github.json, connect to GitHub, clone repos, set up worktree dirs.
 */
const startupPhase = {
  name: "startup",
  run: (context: PhaseContext) =>
    Effect.gen(function* () {
      const ghClient = yield* GitHubClientTag

      // Read github.json
      const ghConfig = yield* readGitHubConfig(context.char.dir)
      const parsedRepos = ghConfig.repos.map((r) => {
        const [owner, repo] = r.split("/")
        return { owner, repo }
      })

      yield* logToConsole(
        context.char.name,
        "orchestrator",
        `GitHub config: ${parsedRepos.length} repo(s) — ${ghConfig.repos.join(", ")}`,
      )

      const clientConfig: GitHubClientConfig = {
        repos: parsedRepos,
        pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
        token: ghConfig.token,
      }

      const { events, initialState, tickIntervalSec, initialTick } =
        yield* ghClient.connect(clientConfig)

      yield* logToConsole(context.char.name, "orchestrator", `Connected to GitHub API`)

      // Clone all repos (shared) and set up worktree directories (per-character)
      for (let i = 0; i < parsedRepos.length; i++) {
        const { owner, repo } = parsedRepos[i]
        yield* logToConsole(context.char.name, "orchestrator", `Setting up ${owner}/${repo}...`)

        const cloneDir = yield* ensureSharedClone(
          context.containerId, owner, repo, ghConfig.token,
        ).pipe(
          Effect.catchAll((e) => {
            return Effect.logWarning(`Failed to clone ${owner}/${repo}: ${e}`).pipe(
              Effect.map(() => sharedClonePath(owner, repo)),
            )
          }),
        )

        const wtBase = yield* ensureWorktreeDir(
          context.containerId, context.char.name, owner, repo,
        ).pipe(Effect.catchAll(() => Effect.succeed(worktreeBasePath(context.char.name, owner, repo))))

        initialState.repos[i].clonePath = cloneDir
        // worktreePath stays null until the agent creates one
      }

      yield* logToConsole(context.char.name, "orchestrator", `All repos ready`)

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
