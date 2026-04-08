import { Effect } from "effect"
import { CommandExecutor } from "@effect/platform"
import { ClaudeError } from "../../../services/Claude.js"
import { OAuthToken } from "../../../services/OAuthToken.js"
import { CharacterLog } from "../../../logging/log-writer.js"
import { runTurn } from "./process-runner.js"
import type { CharacterConfig } from "../../../services/CharacterFs.js"
import type { ModelConfig } from "../../model-config.js"
import { resolveModel } from "../../model-config.js"

/**
 * When a turn times out, generate a short summary of what was accomplished
 * using a quick haiku call.
 */
export const summarizeTimeout = (
  partialOutput: string,
  role: "brain" | "body",
  turnContext: {
    containerId: string
    playerName: string
    char: CharacterConfig
    addDirs?: string[]
    env?: Record<string, string>
    models: ModelConfig
  },
): Effect.Effect<string, ClaudeError, CommandExecutor.CommandExecutor | CharacterLog | OAuthToken> =>
  Effect.gen(function* () {
    // Truncate very long outputs to avoid blowing up the summary call
    const truncated = partialOutput.length > 8000
      ? partialOutput.slice(0, 4000) + "\n\n... (truncated) ...\n\n" + partialOutput.slice(-4000)
      : partialOutput

    const prompt = [
      `The ${role} was interrupted after reaching its time limit.`,
      `Here is its partial output:`,
      ``,
      `---`,
      truncated,
      `---`,
      ``,
      `Summarize in 2-3 sentences: what was accomplished, what was in progress, and what remains to be done.`,
    ].join("\n")

    const result = yield* runTurn({
      containerId: turnContext.containerId,
      playerName: turnContext.playerName,
      char: turnContext.char,
      prompt,
      systemPrompt: "",
      model: resolveModel(turnContext.models, "timeoutSummary", "fast"),
      timeoutMs: 30_000,
      role: "brain",
      noTools: true,
      addDirs: turnContext.addDirs,
      env: turnContext.env,
    })

    return result.output.trim()
  })
