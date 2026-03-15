import { Effect, Queue } from "effect"
import { FileSystem } from "@effect/platform"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import type { GitHubCharacterConfig } from "./types.js"
import type { GitHubState } from "./types.js"
import type { GitHubEvent } from "./types.js"
import type { Phase, PhaseContext, PhaseResult, PhaseRegistry, ConnectionState } from "@signal/core/core/phase.js"
import { Docker } from "@signal/core/services/Docker.js"
import { logToConsole } from "@signal/core/logging/console-renderer.js"
import { CharacterLog } from "@signal/core/logging/log-writer.js"
import { GitHubClientTag } from "./github-client.js"
import { runPlannedAction, runBreak, runReflection } from "@signal/core/core/orchestrator/planned-action.js"
import type { PlannedActionTempo } from "@signal/core/core/limbic/hypothalamus/tempo.js"

const tempo: PlannedActionTempo = {
  _tag: "PlannedAction",
  tickIntervalSec: 30,
  maxCycles: 3,
  breakDurationMs: 90 * 60 * 1000,
  breakPollIntervalSec: 5,
  dreamThreshold: 200,
}

/** Brain timeout in milliseconds (8 minutes). */
const BRAIN_TIMEOUT_MS = 8 * 60 * 1000

/** Body timeout in milliseconds (15 minutes). */
const BODY_TIMEOUT_MS = 15 * 60 * 1000

/** Shared clone path inside the container. */
function sharedClonePath(owner: string, repo: string): string {
  return `/work/repos/${owner}--${repo}`
}

/** Per-character worktree base path. */
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

/** Validate a GitHub token by calling /user. Returns the username. */
const validateToken = (token: string) =>
  Effect.tryPromise({
    try: async () => {
      const r = await fetch("https://api.github.com/user", {
        headers: { Authorization: `token ${token}` },
      })
      if (!r.ok) throw new Error(`GitHub API returned ${r.status}`)
      const user = (await r.json()) as { login: string }
      return user.login
    },
    catch: (e) => new Error(`Token validation failed: ${e}`),
  })

/** Ensure the shared clone exists (idempotent). */
const ensureSharedClone = (
  containerId: string,
  owner: string,
  repo: string,
  token: string,
) =>
  Effect.gen(function* () {
    const docker = yield* Docker
    const cloneDir = sharedClonePath(owner, repo)

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

    yield* docker.exec(containerId, ["mkdir", "-p", "/work/repos"])
    const cloneUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`
    yield* docker.exec(containerId, ["git", "clone", cloneUrl, cloneDir])
    yield* Effect.logInfo(`Cloned ${owner}/${repo} to ${cloneDir}`)
    return cloneDir
  })

/** Ensure the character's worktree directory exists. */
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

    const cloneDir = sharedClonePath(owner, repo)
    yield* docker.exec(containerId, [
      "git", "-C", cloneDir, "config", "user.name", "Claude",
    ]).pipe(Effect.catchAll(() => Effect.void))
    yield* docker.exec(containerId, [
      "git", "-C", cloneDir, "config", "user.email", "noreply@anthropic.com",
    ]).pipe(Effect.catchAll(() => Effect.void))

    return wtBase
  })

/** Internal connection type for GitHub phases. */
type GHConnection = ConnectionState<GitHubState, GitHubEvent>

/**
 * Startup phase: read github.json, validate token, clone repos, connect via GitHubClient.
 */
const startupPhase = {
  name: "startup",
  run: (context: PhaseContext) =>
    Effect.gen(function* () {
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

      // Validate token
      const authenticatedUser = yield* validateToken(ghConfig.token).pipe(
        Effect.catchAll((e) => {
          return Effect.logWarning(`Token validation failed: ${e.message}`).pipe(
            Effect.map(() => ""),
          )
        }),
      )

      yield* logToConsole(
        context.char.name,
        "orchestrator",
        authenticatedUser
          ? `Authenticated as ${authenticatedUser}`
          : `Connected to GitHub API (could not determine username)`,
      )

      // Clone all repos and set up worktree directories
      for (const { owner, repo } of parsedRepos) {
        yield* logToConsole(context.char.name, "orchestrator", `Setting up ${owner}/${repo}...`)

        yield* ensureSharedClone(
          context.containerId, owner, repo, ghConfig.token,
        ).pipe(
          Effect.catchAll((e) => {
            return Effect.logWarning(`Failed to clone ${owner}/${repo}: ${e}`).pipe(
              Effect.map(() => sharedClonePath(owner, repo)),
            )
          }),
        )

        yield* ensureWorktreeDir(
          context.containerId, context.char.name, owner, repo,
        ).pipe(Effect.catchAll(() => Effect.succeed(worktreeBasePath(context.char.name, owner, repo))))
      }

      yield* logToConsole(context.char.name, "orchestrator", `All repos ready`)

      // Connect via GitHubClient to get event queue + initial state
      const ghClient = yield* GitHubClientTag
      const { events, initialState, tickIntervalSec, initialTick } =
        yield* ghClient.connect({
          repos: parsedRepos,
          pollIntervalMs: 30_000,
          token: ghConfig.token,
        })

      yield* logToConsole(context.char.name, "orchestrator", `GitHubClient connected — polling started`)

      const connection: GHConnection = { events, initialState, tickIntervalSec, initialTick }
      return {
        _tag: "Continue",
        next: "active",
        connection,
        data: {
          ghToken: ghConfig.token,
          ghUsername: authenticatedUser,
        },
      } as PhaseResult
    }),
}

/**
 * Active phase: run the planned-action brain/body cycle.
 *
 * Each cycle:
 *   1. Drain pending events and update state
 *   2. Build a brain prompt from current state, identity, values, and diary
 *   3. Run a brain/body cycle via the planned-action scheduler
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

      if (!context.domainBundle) {
        yield* logToConsole(context.char.name, "orchestrator", "No domainBundle in active phase — shutting down")
        return { _tag: "Shutdown" } as PhaseResult
      }

      const conn = context.connection as GHConnection

      const containerEnv = {
        ...context.containerEnv,
        GH_TOKEN: (context.phaseData?.ghToken as string) ?? "",
      }

      // Load system prompts from .md files in this directory
      const brainSystemPrompt = readFileSync(path.join(import.meta.dirname, "brain-system-prompt.md"), "utf-8")
        .replace(/\{\{characterName\}\}/g, context.char.name)
        .replace(/\{\{playerName\}\}/g, context.char.name)
      const bodySystemPrompt = readFileSync(path.join(import.meta.dirname, "body-system-prompt.md"), "utf-8")
        .replace(/\{\{characterName\}\}/g, context.char.name)
        .replace(/\{\{playerName\}\}/g, context.char.name)

      yield* logToConsole(context.char.name, "orchestrator", "Starting planned-action cycle...")

      yield* log.action(context.char, {
        timestamp: new Date().toISOString(),
        source: "orchestrator",
        character: context.char.name,
        type: "loop_start",
        containerId: context.containerId,
      })

      const result = yield* runPlannedAction({
        char: context.char,
        containerId: context.containerId,
        containerEnv,
        addDirs: context.containerAddDirs,
        events: conn.events as Queue.Queue<unknown>,
        initialState: conn.initialState as unknown,
        tempo,
        brainSystemPrompt,
        bodySystemPrompt,
        brainModel: "opus",
        bodyModel: "sonnet",
        brainTimeoutMs: BRAIN_TIMEOUT_MS,
        bodyTimeoutMs: BODY_TIMEOUT_MS,
        brainDisallowedTools: [
          "ToolSearch", "MCPSearch",
          "WebFetch", "WebSearch",
          "NotebookEdit",
          "Edit",
        ],
      }).pipe(Effect.provide(context.domainBundle!))

      const updatedConnection = { ...conn, initialState: result.finalState }
      if (result._tag === "Interrupted") {
        return { _tag: "Continue", next: "active", connection: updatedConnection } as PhaseResult
      }
      return { _tag: "Continue", next: "break", connection: updatedConnection } as PhaseResult
    }),
}

/**
 * Break phase: sleep 90 minutes, polling for critical interrupts.
 * If a critical interrupt fires, exit early to the active phase.
 * Otherwise, proceed to reflection (dream) then active.
 */
const breakPhase = {
  name: "break",
  run: (context: PhaseContext) =>
    Effect.gen(function* () {
      if (!context.connection || !context.domainBundle) {
        return { _tag: "Continue", next: "active", connection: context.connection } as PhaseResult
      }

      const conn = context.connection as GHConnection

      const result = yield* runBreak({
        char: context.char,
        events: conn.events as Queue.Queue<unknown>,
        initialState: conn.initialState as unknown,
        tempo,
      }).pipe(Effect.provide(context.domainBundle!))

      const updatedConnection = { ...conn, initialState: result.finalState }
      if (result._tag === "Interrupted") {
        return { _tag: "Continue", next: "active", connection: updatedConnection } as PhaseResult
      }
      return { _tag: "Continue", next: "reflection", connection: updatedConnection } as PhaseResult
    }),
}

/**
 * Reflection phase: dream to compress diary, then loop back to active.
 */
const reflectionPhase = {
  name: "reflection",
  run: (context: PhaseContext) =>
    Effect.gen(function* () {
      yield* runReflection(context.char, tempo.dreamThreshold)
      return { _tag: "Continue", next: "active", connection: context.connection } as PhaseResult
    }),
}

const allPhases = [
  startupPhase as unknown as Phase,
  activePhase as unknown as Phase,
  breakPhase as unknown as Phase,
  reflectionPhase as unknown as Phase,
] as const

export const gitHubPhaseRegistry: PhaseRegistry = {
  phases: allPhases,
  getPhase: (name: string) => allPhases.find((p) => p.name === name),
  initialPhase: "startup",
}
