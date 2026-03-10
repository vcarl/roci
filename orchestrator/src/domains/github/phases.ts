import { Effect, Queue } from "effect"
import { FileSystem } from "@effect/platform"
import { CommandExecutor } from "@effect/platform"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import type { GitHubCharacterConfig } from "./types.js"
import type { GitHubState } from "./types.js"
import type { GitHubEvent } from "./types.js"
import type { Phase, PhaseContext, PhaseResult, PhaseRegistry, ConnectionState } from "../../core/phase.js"
import { Docker } from "../../services/Docker.js"
import { CharacterFs } from "../../services/CharacterFs.js"
import { logToConsole } from "../../logging/console-renderer.js"
import { CharacterLog } from "../../logging/log-writer.js"
import { EventProcessorTag } from "../../core/limbic/thalamus/event-processor.js"
import { InterruptRegistryTag } from "../../core/limbic/amygdala/interrupt.js"
import { SituationClassifierTag } from "../../core/limbic/thalamus/situation-classifier.js"
import { GitHubClientTag } from "./github-client.js"
import { dream } from "../../core/limbic/hippocampus/dream.js"
import { runCycle } from "../../core/limbic/hypothalamus/cycle-runner.js"
import { Claude } from "../../services/Claude.js"
import type { HypervisorTempo } from "../../core/limbic/hypothalamus/tempo.js"

const tempo: HypervisorTempo = {
  _tag: "Hypervisor",
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
 * Active phase: run the hypervisor brain/body cycle.
 *
 * Each cycle:
 *   1. Drain pending events and update state
 *   2. Build a brain prompt from current state, identity, values, and diary
 *   3. Run a brain/body cycle via the hypervisor scheduler
 */
const activePhase = {
  name: "active",
  run: (context: PhaseContext) =>
    Effect.gen(function* () {
      const log = yield* CharacterLog
      const charFs = yield* CharacterFs
      const docker = yield* Docker

      if (!context.connection) {
        yield* logToConsole(context.char.name, "orchestrator", "No connection in active phase — shutting down")
        return { _tag: "Shutdown" } as PhaseResult
      }

      if (!context.domainBundle) {
        yield* logToConsole(context.char.name, "orchestrator", "No domainBundle in active phase — shutting down")
        return { _tag: "Shutdown" } as PhaseResult
      }

      const conn = context.connection as GHConnection
      let currentState = conn.initialState

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

      yield* logToConsole(context.char.name, "orchestrator", "Starting hypervisor cycle...")

      yield* log.action(context.char, {
        timestamp: new Date().toISOString(),
        source: "orchestrator",
        character: context.char.name,
        type: "loop_start",
        containerId: context.containerId,
      })

      for (let cycle = 0; cycle < tempo.maxCycles; cycle++) {
        // Drain pending events and update state
        let drained = false
        while (!drained) {
          const maybeEvent = yield* Queue.poll(conn.events)
          if (maybeEvent._tag === "None") {
            drained = true
          } else {
            const event = maybeEvent.value
            yield* Effect.gen(function* () {
              const eventProcessor = yield* EventProcessorTag
              const result = eventProcessor.processEvent(event, currentState)
              if (result.stateUpdate) {
                currentState = result.stateUpdate(currentState) as GitHubState
              }
            }).pipe(Effect.provide(context.domainBundle!))
          }
        }

        // Get situation summary from classifier (via domainBundle)
        const summary = yield* Effect.gen(function* () {
          const classifier = yield* SituationClassifierTag
          return classifier.summarize(currentState)
        }).pipe(Effect.provide(context.domainBundle!))

        // Read character identity
        const background = yield* charFs.readBackground(context.char).pipe(
          Effect.catchAll(() => Effect.succeed(""))
        )
        const values = yield* charFs.readValues(context.char).pipe(
          Effect.catchAll(() => Effect.succeed(""))
        )

        // Read character diary
        const diary = yield* charFs.readDiary(context.char)

        const buildBrainPrompt = () => {
          const stateSummary = summary.sections
            .map(s => `## ${s.heading}\n${s.body}`)
            .join("\n\n")
          const parts = [
            `# Current State\n\n${stateSummary}`,
          ]
          if (background) {
            parts.push(`\n\n# Your Identity\n\n${background}`)
          }
          if (values) {
            parts.push(`\n\n# Your Values\n\n${values}`)
          }
          parts.push(`\n\n# Diary\n\n${diary.slice(-3000)}`)
          return parts.join("")
        }

        yield* logToConsole(context.char.name, "orchestrator", `Cycle ${cycle + 1}/${tempo.maxCycles}`)

        const cycleResult = yield* runCycle({
          containerId: context.containerId,
          playerName: context.char.name,
          brainSystemPrompt,
          bodySystemPrompt,
          brainModel: "opus",
          bodyModel: "sonnet",
          brainTimeoutMs: BRAIN_TIMEOUT_MS,
          bodyTimeoutMs: BODY_TIMEOUT_MS,
          env: containerEnv,
          char: context.char,
          buildBrainPrompt,
          brainDisallowedTools: [
            "ToolSearch", "MCPSearch",
            "WebFetch", "WebSearch",
            "NotebookEdit",
            "Edit",
          ],
        })

        yield* logToConsole(
          context.char.name,
          "orchestrator",
          `Cycle ${cycle + 1} complete — brain: ${Math.round(cycleResult.brainResult.durationMs / 1000)}s, body: ${Math.round(cycleResult.bodyResult.durationMs / 1000)}s`,
        )
      }

      // Thread updated state into the connection for the next phase
      const updatedConnection: GHConnection = { ...conn, initialState: currentState }
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

      yield* logToConsole(context.char.name, "orchestrator", `Break phase — resting for ${tempo.breakDurationMs / 60_000} minutes (monitoring for critical interrupts)`)

      const startTime = Date.now()
      // Track state locally so we can detect critical interrupts
      let currentState = conn.initialState

      // Poll loop: drain events, check for critical interrupts
      let interrupted = false
      while (Date.now() - startTime < tempo.breakDurationMs) {
        // Drain all pending events without blocking
        let drained = false
        while (!drained) {
          const maybeEvent = yield* Queue.poll(conn.events)
          if (maybeEvent._tag === "None") {
            drained = true
          } else {
            const event = maybeEvent.value

            // Process through domain event processor to get state update
            yield* Effect.gen(function* () {
              const eventProcessor = yield* EventProcessorTag
              const classifier = yield* SituationClassifierTag
              const interruptRegistry = yield* InterruptRegistryTag

              const result = eventProcessor.processEvent(event, currentState)

              if (result.stateUpdate) {
                currentState = result.stateUpdate(currentState) as GitHubState
              }

              // Only check for critical interrupts on state updates
              if (result.category?._tag === "StateChange") {
                const summary = classifier.summarize(currentState)
                const criticals = interruptRegistry.criticals(currentState, summary.situation)

                if (criticals.length > 0) {
                  yield* logToConsole(
                    context.char.name,
                    "orchestrator",
                    `Critical interrupt during break: ${criticals.map(a => a.message).join("; ")} — waking up`,
                  )
                  interrupted = true
                }
              }
            }).pipe(Effect.provide(context.domainBundle))

            if (interrupted) break
          }
        }

        if (interrupted) break

        yield* Effect.sleep(`${tempo.breakPollIntervalSec} seconds`)
      }

      // Thread updated state into the connection for the next active phase
      const updatedConnection: GHConnection = { ...conn, initialState: currentState }

      if (interrupted) {
        return { _tag: "Continue", next: "active", connection: updatedConnection } as PhaseResult
      }

      const elapsedMin = Math.round((Date.now() - startTime) / 60_000)
      yield* logToConsole(context.char.name, "orchestrator", `Break complete (${elapsedMin} min) — proceeding to reflection`)
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
      const charFs = yield* CharacterFs

      const diary = yield* charFs.readDiary(context.char)
      const diaryLines = diary.split("\n").length
      if (diaryLines > tempo.dreamThreshold) {
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
  breakPhase as unknown as Phase,
  reflectionPhase as unknown as Phase,
] as const

export const gitHubPhaseRegistry: PhaseRegistry = {
  phases: allPhases,
  getPhase: (name: string) => allPhases.find((p) => p.name === name),
  initialPhase: "startup",
}
