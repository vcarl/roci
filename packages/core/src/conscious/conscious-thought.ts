import * as path from "node:path"
import { Context, Effect, Layer } from "effect"
import { CommandExecutor } from "@effect/platform"
import type { ModelHandle } from "../model/handles.js"
import type { CharacterConfig } from "../services/CharacterFs.js"
import type { TurnConfig, TurnResult } from "../core/limbic/hypothalamus/types.js"
import { runOpenCodeSessionTurn } from "../core/limbic/hypothalamus/process-runner.js"
import { CharacterLog, logError } from "../logging/log-writer.js"
import { OAuthToken } from "../services/OAuthToken.js"
import { Docker } from "../services/Docker.js"
import {
  provisionConsciousProvider,
  writeCharacterAgentFile,
  consciousModelLabel,
  CONSCIOUS_AGENT_NAME,
} from "./opencode-config.js"
import type { AnyModel } from "../core/limbic/hypothalamus/runtime.js"
import { provisionFrontierCli } from "./frontier-cli.js"
import { provisionMemoryCli } from "./memory-cli.js"
import { DEFAULT_EMBED_BASE_URL } from "./memory-embed.js"

/** Config for a single conscious-tier OpenCode turn. */
export interface ConsciousTurnConfig {
  containerId: string
  playerName: string
  char: CharacterConfig
  /** The prompt text: step task on turn 1, directive text on steer turns. */
  prompt: string
  /** Wall-clock budget for this turn. */
  timeoutMs: number
  /**
   * The `-m` label for the body model — `consciousModelLabel(handle)`, i.e.
   * `local/<real-model-id>`. MUST agree with the agent file's frontmatter `model:`
   * written at provision time. Threaded from the cortex loop where the handle resolves.
   */
  modelLabel: string
}

/** The inputs to `provision`, derived by the loop from `CortexLoopConfig`. */
export interface ProvisionOpts {
  containerId: string
  char: CharacterConfig
  handle: ModelHandle
  systemPrompt: string
  /** Model the frontier worker runs on (e.g. "sonnet"). */
  frontierModel: AnyModel
  /** Wall-clock budget baked into the frontier worker (reuses workerTimeoutMs). */
  frontierTimeoutMs: number
  /**
   * Host embed server base URL for the long-term `memory` CLI. Loopback is fine —
   * it is rewritten to host.docker.internal at provision time. Defaults to the
   * standalone host embed server (`DEFAULT_EMBED_BASE_URL`, port 8084).
   */
  embedBaseUrl?: string
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
    readonly provision: (opts: ProvisionOpts) => Effect.Effect<void, never, Docker | CharacterLog>

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

const provisionImpl = (opts: ProvisionOpts): Effect.Effect<void, never, Docker | CharacterLog> =>
  Effect.gen(function* () {
    // Write the project-local agent file (host-side fs). Deferred into the Effect so a
    // filesystem failure becomes a swallowed error, not a synchronous throw / defect.
    // char.dir = players/<name>/me, grandparent = players/.
    yield* Effect.try(() =>
      writeCharacterAgentFile({
        playersDir: path.resolve(opts.char.dir, "../.."),
        playerName: opts.char.name,
        systemPrompt: opts.systemPrompt,
        // Frontmatter `model:` = handle-derived label; agrees with the `-m` label at turn time.
        modelLabel: consciousModelLabel(opts.handle),
      }),
    )
    // Provision the global in-container provider config (requires Docker).
    yield* provisionConsciousProvider(opts.containerId, opts.handle)
    // Provision the frontier CLI (heavy-lifting delegation tool) into the container.
    yield* provisionFrontierCli(opts.containerId, {
      model: opts.frontierModel,
      timeoutMs: opts.frontierTimeoutMs,
    })
    // Provision the memory CLI (append-only long-term store) into the container.
    // Runs as root inside provisionMemoryCli; a failure PROPAGATES here so it is
    // logged loud (kind:error) with the character context and the loop continues
    // (long-term memory degrades, but the agent keeps running) — instead of the
    // old silent swallow that surfaced only as a later "command not found".
    yield* provisionMemoryCli(opts.containerId, {
      embedBaseUrl: opts.embedBaseUrl ?? DEFAULT_EMBED_BASE_URL,
    }).pipe(
      Effect.catchAll((e) =>
        logError(
          opts.char.name,
          "conscious",
          `memory CLI provisioning failed (long-term memory unavailable this run): ${e}`,
        ).pipe(Effect.catchAll(() => Effect.void)),
      ),
    )
  }).pipe(
    // Error channel is `never`: a write failure or DockerError is swallowed (idempotent;
    // safe to retry next run) and surfaces downstream as a turn-1 failure.
    Effect.catchAll(() => Effect.void),
  )

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
    // Handle-derived `-m` label; MUST match the agent file's frontmatter `model:`.
    model: config.modelLabel,
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
 * The Test layer returns a caller-supplied canned TurnResult without touching transport.
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
      provision: () => Effect.void as Effect.Effect<void, never, Docker | CharacterLog>,
      turn: (config, resume) =>
        Effect.sync(() => {
          // Capture steer directives: any resume call's prompt is a directive.
          if (resume && onSteer) onSteer(config.prompt)
          return impl(config, resume)
        }),
    }),
  )
