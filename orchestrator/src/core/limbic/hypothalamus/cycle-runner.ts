import { Effect } from "effect"
import { CommandExecutor } from "@effect/platform"
import type { CycleConfig, CycleResult } from "./types.js"
import { runTurn } from "./process-runner.js"
import { summarizeTimeout } from "./timeout-summarizer.js"
import { Claude, ClaudeError } from "../../../services/Claude.js"
import { OAuthToken } from "../../../services/OAuthToken.js"
import { CharacterLog } from "../../../logging/log-writer.js"
import { logToConsole } from "../../../logging/console-renderer.js"

/**
 * Run a single brain/body cycle:
 * 1. Build the brain's input prompt
 * 2. Run brain (Opus) with timeout — streams output to console
 * 3. If brain timed out, summarize
 * 4. Run body (Sonnet) with brain output as prompt — streams output to console
 * 5. If body timed out, summarize
 * 6. Return results
 */
export const runCycle = (
  config: CycleConfig,
): Effect.Effect<CycleResult, ClaudeError | Error, Claude | CommandExecutor.CommandExecutor | CharacterLog | OAuthToken> =>
  Effect.gen(function* () {
    const playerName = config.playerName

    // 1. Build brain prompt from state
    const brainPrompt = config.buildBrainPrompt()

    yield* logToConsole(playerName, "planned-action", `Starting brain turn (${Math.round(config.brainTimeoutMs / 1000)}s timeout)`)

    // 2. Run brain
    const brainResult = yield* runTurn({
      containerId: config.containerId,
      playerName,
      systemPrompt: config.brainSystemPrompt,
      prompt: brainPrompt,
      model: config.brainModel,
      timeoutMs: config.brainTimeoutMs,
      env: config.env,
      addDirs: config.addDirs,
      char: config.char,
      role: "brain",
      allowedTools: config.brainAllowedTools,
      disallowedTools: config.brainDisallowedTools,
    })

    let brainOutput = brainResult.output
    let brainSummary: string | undefined

    yield* logToConsole(
      playerName,
      "planned-action",
      `Brain turn complete (${Math.round(brainResult.durationMs / 1000)}s)${brainResult.timedOut ? " — TIMED OUT" : ""}`,
    )

    if (brainResult.timedOut) {
      brainSummary = yield* summarizeTimeout(brainOutput, "brain").pipe(
        Effect.catchAll((e) => {
          return Effect.logWarning(`Brain summary failed: ${e.message}`).pipe(
            Effect.map(() => "(brain timed out, summary unavailable)"),
          )
        }),
      )
      brainOutput = brainSummary
      yield* logToConsole(playerName, "planned-action", `Brain timeout summary: ${brainSummary.slice(0, 200)}`)
    }

    yield* logToConsole(playerName, "planned-action", `Starting body turn (${Math.round(config.bodyTimeoutMs / 1000)}s timeout)`)

    // 3. Run body with brain output as prompt
    const bodyResult = yield* runTurn({
      containerId: config.containerId,
      playerName,
      systemPrompt: config.bodySystemPrompt,
      prompt: brainOutput,
      model: config.bodyModel,
      timeoutMs: config.bodyTimeoutMs,
      env: config.env,
      addDirs: config.addDirs,
      char: config.char,
      role: "body",
    })

    let bodySummary: string | undefined

    yield* logToConsole(
      playerName,
      "planned-action",
      `Body turn complete (${Math.round(bodyResult.durationMs / 1000)}s)${bodyResult.timedOut ? " — TIMED OUT" : ""}`,
    )

    if (bodyResult.timedOut) {
      bodySummary = yield* summarizeTimeout(bodyResult.output, "body").pipe(
        Effect.catchAll((e) => {
          return Effect.logWarning(`Body summary failed: ${e.message}`).pipe(
            Effect.map(() => "(body timed out, summary unavailable)"),
          )
        }),
      )
      yield* logToConsole(playerName, "planned-action", `Body timeout summary: ${bodySummary.slice(0, 200)}`)
    }

    return {
      brainResult,
      bodyResult,
      brainSummary,
      bodySummary,
    }
  })
