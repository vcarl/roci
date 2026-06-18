import { Context, Effect, Layer } from "effect"
import { CommandExecutor } from "@effect/platform"
import { runTurn } from "../core/limbic/hypothalamus/process-runner.js"
import { ClaudeError } from "../services/Claude.js"
import { OAuthToken } from "../services/OAuthToken.js"
import { CharacterLog } from "../logging/log-writer.js"
import type { DelegationConfig, DelegationResult } from "./types.js"
import { toDelegationResult } from "./result.js"

export class Cybernetics extends Context.Tag("Cybernetics")<
  Cybernetics,
  {
    readonly delegate: (
      config: DelegationConfig,
    ) => Effect.Effect<
      DelegationResult,
      never,
      CommandExecutor.CommandExecutor | CharacterLog | OAuthToken
    >
  }
>() {}

const delegate = (
  config: DelegationConfig,
): Effect.Effect<DelegationResult, never, CommandExecutor.CommandExecutor | CharacterLog | OAuthToken> =>
  runTurn({
    containerId: config.containerId,
    playerName: config.playerName,
    char: config.char,
    prompt: config.task,
    systemPrompt: config.systemPrompt,
    model: config.model,
    timeoutMs: config.timeoutMs,
    role: "body",
    noTools: false,
    allowedTools: config.allowedTools,
    addDirs: config.addDirs,
    env: config.env,
  }).pipe(
    Effect.map(toDelegationResult),
    // A failed claude invocation (e.g. auth) is captured, not thrown.
    Effect.catchAll((e: ClaudeError) =>
      Effect.succeed<DelegationResult>({ status: "failed", output: e.message, durationMs: 0 }),
    ),
  )

/** Production layer — spawns claude -p in the container via runTurn. */
export const CyberneticsLive = Layer.succeed(Cybernetics, Cybernetics.of({ delegate }))

/** Test layer — returns canned results without touching Docker. */
export const CyberneticsTest = (
  impl: (config: DelegationConfig) => DelegationResult,
): Layer.Layer<Cybernetics> =>
  Layer.succeed(Cybernetics, Cybernetics.of({ delegate: (config) => Effect.succeed(impl(config)) }))
