import { Effect } from "effect"
import { FileSystem } from "@effect/platform"
import type { GitHubCharacterConfig } from "./types.js"
import type { Phase, PhaseContext, PhaseResult, PhaseRegistry } from "../../core/phase.js"
import { Docker } from "../../services/Docker.js"
import { logToConsole } from "../../logging/console-renderer.js"
import { CharacterLog } from "../../logging/log-writer.js"
import { runCycle } from "../../hypervisor/scheduler.js"
import { pollAndWriteState } from "./state-poller.js"
import { renderTemplate } from "../../core/template.js"
import { readFileSync } from "node:fs"
import * as path from "node:path"

/** Number of brain/body cycles before exiting. */
const MAX_CYCLES = 20

/** Brain timeout: 2 minutes. */
const BRAIN_TIMEOUT_MS = 2 * 60 * 1000

/** Body timeout: 8 minutes. */
const BODY_TIMEOUT_MS = 8 * 60 * 1000

/** Poll interval between cycles: 30 seconds. */
const POLL_INTERVAL_MS = 30_000

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

/** Load a system prompt template from disk and render variables. */
function loadSystemPrompt(filename: string, vars: Record<string, string>): string {
  const filePath = path.resolve(import.meta.dirname, filename)
  const raw = readFileSync(filePath, "utf-8")
  return renderTemplate(raw, vars)
}

/**
 * Startup phase: read github.json, validate token, clone repos, set up worktree dirs.
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

      return {
        _tag: "Continue",
        next: "active",
        data: {
          ghToken: ghConfig.token,
          ghUsername: authenticatedUser,
          ghConfig,
        },
      } as PhaseResult
    }),
}

/**
 * Active phase: run brain/body cycles using the hypervisor scheduler.
 */
const activePhase = {
  name: "active",
  run: (context: PhaseContext) =>
    Effect.gen(function* () {
      const log = yield* CharacterLog

      const ghToken = context.phaseData?.ghToken as string | undefined
      const ghUsername = context.phaseData?.ghUsername as string ?? ""
      const ghConfig = context.phaseData?.ghConfig as GitHubCharacterConfig | undefined

      if (!ghConfig || !ghToken) {
        yield* logToConsole(context.char.name, "orchestrator", "No GitHub config in active phase — shutting down")
        return { _tag: "Shutdown" } as PhaseResult
      }

      const containerEnv = {
        ...context.containerEnv,
        GH_TOKEN: ghToken,
      }

      // Load system prompt templates
      const templateVars = {
        characterName: context.char.name,
        playerName: context.char.name,
      }
      const brainSystemPrompt = loadSystemPrompt("brain-system-prompt.md", templateVars)
      const bodySystemPrompt = loadSystemPrompt("body-system-prompt.md", templateVars)

      yield* logToConsole(context.char.name, "hypervisor", "Starting brain/body cycles...")

      yield* log.action(context.char, {
        timestamp: new Date().toISOString(),
        source: "orchestrator",
        character: context.char.name,
        type: "hypervisor_start",
        containerId: context.containerId,
      })

      // Create reports directory in container
      const docker = yield* Docker
      yield* docker.exec(context.containerId, [
        "mkdir", "-p", `/work/players/${context.char.name}/reports`,
      ]).pipe(Effect.catchAll(() => Effect.void))

      let cycleCount = 0

      while (cycleCount < MAX_CYCLES) {
        cycleCount++
        yield* logToConsole(context.char.name, "hypervisor", `--- Cycle ${cycleCount}/${MAX_CYCLES} ---`)

        // 1. Poll GitHub state and write to container
        yield* logToConsole(context.char.name, "hypervisor", "Polling GitHub state...")
        const stateMarkdown = yield* pollAndWriteState(
          context.containerId,
          context.char.name,
          ghConfig,
          ghUsername,
        ).pipe(
          Effect.catchAll((e) => {
            return logToConsole(context.char.name, "hypervisor", `Poll failed: ${e}`).pipe(
              Effect.map(() => "# State unavailable — poll failed\n"),
            )
          }),
        )

        // 2. Run brain/body cycle
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
          buildBrainPrompt: () => [
            "Read your state file, diary, and recent reports, then prepare a briefing for the body.",
            "",
            "Current state summary (also available at /work/players/" + context.char.name + "/state.md):",
            "",
            stateMarkdown,
          ].join("\n"),
        }).pipe(
          Effect.catchAll((e) => {
            return logToConsole(context.char.name, "hypervisor", `Cycle failed: ${e}`).pipe(
              Effect.map(() => null),
            )
          }),
        )

        if (cycleResult) {
          // 3. Store body report for next brain cycle
          const report = cycleResult.bodySummary ?? cycleResult.bodyResult.output
          const reportTimestamp = new Date().toISOString().replace(/[:.]/g, "-")
          const b64Report = Buffer.from(report).toString("base64")
          yield* docker.exec(context.containerId, [
            "bash", "-c",
            `echo '${b64Report}' | base64 -d > /work/players/${context.char.name}/reports/${reportTimestamp}.md`,
          ]).pipe(Effect.catchAll(() => Effect.void))

          // Log cycle results
          yield* log.action(context.char, {
            timestamp: new Date().toISOString(),
            source: "orchestrator",
            character: context.char.name,
            type: "cycle_complete",
            cycle: cycleCount,
            brainDurationMs: cycleResult.brainResult.durationMs,
            bodyDurationMs: cycleResult.bodyResult.durationMs,
            brainTimedOut: cycleResult.brainResult.timedOut,
            bodyTimedOut: cycleResult.bodyResult.timedOut,
          })
        }

        // Brief pause between cycles
        if (cycleCount < MAX_CYCLES) {
          yield* logToConsole(context.char.name, "hypervisor", `Waiting ${POLL_INTERVAL_MS / 1000}s before next cycle...`)
          yield* Effect.sleep(POLL_INTERVAL_MS)
        }
      }

      yield* logToConsole(context.char.name, "hypervisor", `Completed ${cycleCount} cycles — shutting down`)
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
