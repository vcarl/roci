import { Effect } from "effect"
import { Claude, ClaudeError } from "../../../services/Claude.js"

/**
 * When a turn times out, generate a short summary of what was accomplished
 * using a quick haiku call.
 */
export const summarizeTimeout = (
  partialOutput: string,
  role: "brain" | "body",
): Effect.Effect<string, ClaudeError, Claude> =>
  Effect.gen(function* () {
    const claude = yield* Claude

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

    const summary = yield* claude.invoke({
      prompt,
      model: "nvidia/nemotron-3-nano-30b-a3b:free",
      maxTurns: 1,
    })

    return summary.trim()
  })
