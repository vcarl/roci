import * as path from "node:path"
import { Context, Effect, Layer } from "effect"
import { CommandExecutor } from "@effect/platform"
import type { ModelHandle } from "../model/handles.js"
import type { CharacterConfig } from "../services/CharacterFs.js"
import type { TurnConfig, TurnResult } from "../core/limbic/hypothalamus/types.js"
import { runOpenCodeSessionTurn } from "../core/limbic/hypothalamus/process-runner.js"
import { CharacterLog } from "../logging/log-writer.js"
import { OAuthToken } from "../services/OAuthToken.js"
import { Docker } from "../services/Docker.js"
import {
  provisionConsciousProvider,
  writeCharacterAgentFile,
  CONSCIOUS_MODEL_LABEL,
  CONSCIOUS_AGENT_NAME,
} from "./opencode-config.js"

/** Config for a single conscious-tier OpenCode turn. */
export interface ConsciousTurnConfig {
  containerId: string
  playerName: string
  char: CharacterConfig
  /** The prompt text: step task on turn 1, directive text on steer turns. */
  prompt: string
  /** Wall-clock budget for this turn. */
  timeoutMs: number
}

/** The inputs to `provision`, derived by the loop from `CortexLoopConfig`. */
export interface ProvisionOpts {
  containerId: string
  char: CharacterConfig
  handle: ModelHandle
  systemPrompt: string
}

export class ConsciousThought extends Context.Tag("ConsciousThought")<
  ConsciousThought,
  {
    /**
     * Provision the conscious agent once before the loop starts.
     * Writes the global per-container OpenCode provider config and the
     * project-local character agent file. Error channel is `never` — a Docker
     * failure here is swallowed (idempotent; safe to retry next run) but is NOT
     * silently lost: if provisioning failed, turn 1 fails loudly with an OpenCode
     * "unknown provider/model" error, which flows through the normal failed-result
     * path into the step report and evaluate. Explicit provisioning diagnostics
     * are deferred to Phase 4c.
     */
    readonly provision: (opts: ProvisionOpts) => Effect.Effect<void, never, Docker>

    /**
     * Run one turn of the conscious session. First call (no `resume`) opens a
     * new OpenCode session; subsequent calls resume the same session by id.
     * Error channel is `never` — a transport failure becomes a failed-style
     * result (output = error message, sessionId = carried from resume or sentinel).
     */
    readonly turn: (
      config: ConsciousTurnConfig,
      resume?: { sessionId: string },
    ) => Effect.Effect<
      { result: TurnResult; sessionId: string },
      never,
      CommandExecutor.CommandExecutor | CharacterLog | OAuthToken
    >
  }
>() {}

const provisionImpl = (opts: ProvisionOpts): Effect.Effect<void, never, Docker> => {
  // Derive playersDir from char.dir: char.dir = players/<name>/me, grandparent = players/
  const playersDir = path.resolve(opts.char.dir, "../..")
  // Write the project-local agent file synchronously (host-side fs, no Effect service).
  writeCharacterAgentFile({
    playersDir,
    playerName: opts.char.name,
    systemPrompt: opts.systemPrompt,
    modelLabel: CONSCIOUS_MODEL_LABEL,
  })
  // Provision the global in-container provider config (requires Docker).
  return provisionConsciousProvider(opts.containerId, opts.handle).pipe(
    Effect.asVoid,
    Effect.catchAll(() => Effect.void),
  )
}

const turnImpl = (
  config: ConsciousTurnConfig,
  resume?: { sessionId: string },
): Effect.Effect<
  { result: TurnResult; sessionId: string },
  never,
  CommandExecutor.CommandExecutor | CharacterLog | OAuthToken
> => {
  const turnConfig: TurnConfig = {
    containerId: config.containerId,
    playerName: config.playerName,
    char: config.char,
    systemPrompt: "", // system prompt is supplied via the agent file, not --system-prompt
    model: CONSCIOUS_MODEL_LABEL,
    agentName: CONSCIOUS_AGENT_NAME,
    prompt: config.prompt,
    timeoutMs: config.timeoutMs,
    role: "body",
  }
  return runOpenCodeSessionTurn(turnConfig, resume).pipe(
    Effect.catchAll((e) =>
      Effect.succeed({
        result: { output: e.message, timedOut: false, durationMs: 0 },
        sessionId: resume?.sessionId ?? "error-sentinel",
      }),
    ),
  )
}

/** Production layer — runs provision against Docker and turn over the shared transport. */
export const ConsciousThoughtLive: Layer.Layer<ConsciousThought> = Layer.succeed(
  ConsciousThought,
  ConsciousThought.of({
    provision: provisionImpl,
    turn: turnImpl,
  }),
)

/**
 * Test layer — no-op `provision`, returns canned `turn` results, and captures
 * steer directive text (the prompt on resume calls) via `onSteer`.
 * Mirrors `CyberneticsTest` in `cybernetics/delegate.ts`.
 */
export const ConsciousThoughtTest = (
  impl: (
    config: ConsciousTurnConfig,
    resume?: { sessionId: string },
  ) => { result: TurnResult; sessionId: string },
  onSteer?: (directiveText: string) => void,
): Layer.Layer<ConsciousThought> =>
  Layer.succeed(
    ConsciousThought,
    ConsciousThought.of({
      provision: () => Effect.void as Effect.Effect<void, never, Docker>,
      turn: (config, resume) =>
        Effect.sync(() => {
          // Capture steer directives: any resume call's prompt is a directive.
          if (resume && onSteer) onSteer(config.prompt)
          return impl(config, resume)
        }),
    }),
  )
