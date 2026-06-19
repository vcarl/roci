import { Context, Effect, Layer, Queue, Chunk } from "effect"
import { CommandExecutor } from "@effect/platform"
import { runTurn, runSdkSession } from "../core/limbic/hypothalamus/process-runner.js"
import { ClaudeError } from "../services/Claude.js"
import { OAuthToken } from "../services/OAuthToken.js"
import { CharacterLog } from "../logging/log-writer.js"
import type { DelegationConfig, DelegationResult, Directive } from "./types.js"
import { buildSteeredStdinStream } from "./steering.js"
import { toDelegationResult } from "./result.js"

export class Cybernetics extends Context.Tag("Cybernetics")<
  Cybernetics,
  {
    readonly delegate: (
      config: DelegationConfig,
      steering?: Queue.Queue<Directive>,
    ) => Effect.Effect<
      DelegationResult,
      never,
      CommandExecutor.CommandExecutor | CharacterLog | OAuthToken
    >
  }
>() {}

/** Map a DelegationConfig to the TurnConfig both payload paths consume. */
const toTurnConfig = (config: DelegationConfig) => ({
  containerId: config.containerId,
  playerName: config.playerName,
  char: config.char,
  prompt: config.task,
  systemPrompt: config.systemPrompt,
  model: config.model,
  timeoutMs: config.timeoutMs,
  role: "body" as const,
  noTools: false,
  allowedTools: config.allowedTools,
  addDirs: config.addDirs,
  env: config.env,
})

const delegate = (
  config: DelegationConfig,
  steering?: Queue.Queue<Directive>,
): Effect.Effect<DelegationResult, never, CommandExecutor.CommandExecutor | CharacterLog | OAuthToken> => {
  // With a steering queue → the steerable SDK session (only it speaks the wire
  // protocol). Without → the existing run-to-completion path (unchanged behavior).
  const turn = steering
    ? runSdkSession(toTurnConfig(config), buildSteeredStdinStream(config.task, steering))
    : runTurn(toTurnConfig(config))
  return turn.pipe(
    Effect.map(toDelegationResult),
    // A failed invocation (e.g. auth) is captured, not thrown.
    Effect.catchAll((e: ClaudeError) =>
      Effect.succeed<DelegationResult>({ status: "failed", output: e.message, durationMs: 0 }),
    ),
  )
}

/** Production layer — spawns the worker in the container via the transport. */
export const CyberneticsLive = Layer.succeed(Cybernetics, Cybernetics.of({ delegate }))

/**
 * Test layer — returns canned results without touching Docker. When a steering
 * queue is provided and `onSteer` is set, every directive currently buffered on
 * the queue (point-in-time, non-blocking) is reported for assertions.
 */
export const CyberneticsTest = (
  impl: (config: DelegationConfig) => DelegationResult,
  onSteer?: (directive: Directive) => void,
): Layer.Layer<Cybernetics> =>
  Layer.succeed(
    Cybernetics,
    Cybernetics.of({
      delegate: (config, steering) =>
        Effect.gen(function* () {
          if (steering && onSteer) {
            const pending = yield* Queue.takeAll(steering)
            for (const d of Chunk.toReadonlyArray(pending)) onSteer(d)
          }
          return impl(config)
        }),
    }),
  )
