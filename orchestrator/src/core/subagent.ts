import { Effect, Ref } from "effect"
import { Claude, ClaudeError } from "../services/Claude.js"
import { CharacterLog } from "../logging/log-writer.js"
import { demuxStream } from "../logging/log-demux.js"
import { logStderr, logStreamEvent } from "../logging/console-renderer.js"
import type { CharacterConfig } from "../services/CharacterFs.js"
import { PromptBuilderTag } from "./prompt-builder.js"
import type { PlanStep } from "./types.js"
import type { GameState, Situation } from "../game/types.js"

export interface SubagentInput {
  char: CharacterConfig
  containerId: string
  playerName: string
  systemPrompt: string
  containerEnv?: Record<string, string>
  step: PlanStep
  state: GameState
  situation: Situation
  personality: string
  values: string
  tickIntervalSec: number
}

/** Spawn a subagent in a container. Returns the accumulated subagent text output. */
export const runGenericSubagent = (input: SubagentInput) =>
  Effect.gen(function* () {
    const claude = yield* Claude
    const log = yield* CharacterLog
    const promptBuilder = yield* PromptBuilderTag

    const prompt = promptBuilder.subagentPrompt({
      step: input.step,
      state: input.state,
      situation: input.situation,
      identity: {
        personality: input.personality,
        values: input.values,
        tickIntervalSec: input.tickIntervalSec,
      },
    })

    yield* log.action(input.char, {
      timestamp: new Date().toISOString(),
      source: "orchestrator",
      character: input.char.name,
      type: "subagent_spawn",
      task: input.step.task,
      goal: input.step.goal,
      model: input.step.model,
    })

    const textRef = yield* Ref.make<string[]>([])

    const { exitCode, stderr } = yield* Effect.scoped(
      Effect.gen(function* () {
        const { stream, waitForExit } = yield* claude.execInContainer({
          containerId: input.containerId,
          playerName: input.playerName,
          prompt,
          model: input.step.model,
          systemPrompt: input.systemPrompt,
          outputFormat: "stream-json",
          env: input.containerEnv,
        })

        yield* demuxStream(input.char, stream, "subagent", textRef)
        return yield* waitForExit
      }),
    )

    if (stderr.trim()) {
      yield* logStderr(input.char.name, stderr)
    }

    if (exitCode !== 0) {
      yield* log.action(input.char, {
        timestamp: new Date().toISOString(),
        source: "orchestrator",
        character: input.char.name,
        type: "subagent_error",
        task: input.step.task,
        exitCode,
        stderr: stderr.trim().slice(0, 1000),
      })
      return yield* Effect.fail(
        new ClaudeError(
          `Subagent exited with code ${exitCode}: ${stderr.trim().slice(0, 500)}`,
        ),
      )
    }

    const collectedText = yield* Ref.get(textRef)

    if (collectedText.length === 0) {
      yield* logStreamEvent(input.char.name, "warn", "Subagent produced no text output")
    }

    yield* log.action(input.char, {
      timestamp: new Date().toISOString(),
      source: "orchestrator",
      character: input.char.name,
      type: "subagent_complete",
      task: input.step.task,
    })

    return collectedText.join("\n")
  })
