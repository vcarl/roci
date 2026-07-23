import * as path from "node:path"
import { Context, Effect, Layer } from "effect"
import { CommandExecutor } from "@effect/platform"
import type { ModelHandle } from "../../../model/handles.js"
import type { CharacterConfig } from "../../../services/CharacterFs.js"
import type { TurnConfig, TurnResult } from "#brain/stem/transport/types.js"
import { runOpenCodeSessionTurn } from "./session-runner.js"
import { CharacterLog } from "../../../logging/log-writer.js"
import { OAuthToken } from "../../../services/OAuthToken.js"
import { Docker } from "../../../services/Docker.js"
import {
  provisionConsciousProvider,
  writeCharacterAgentFile,
  writeCharacterOpencodeConfig,
} from "./opencode-config.js"
import { CONSCIOUS_AGENT_NAME } from "#brain/stem/transport/consts.js"
import { consciousModelLabel } from "../../../model/conscious-label.js"
import type { AnyModel } from "../../../model/runtime.js"
import { provisionFrontierCli } from "./frontier-cli.js"
import { ensureSeedSkills } from "../../../services/skills-core.js"

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

/** The inputs to `provision`, derived by the loop from `ActivationConfig`. */
export interface ProvisionOpts {
  containerId: string
  char: CharacterConfig
  handle: ModelHandle
  systemPrompt: string
  /** Model the frontier worker runs on (e.g. "sonnet"). */
  frontierModel: AnyModel
  /** Wall-clock budget baked into the frontier worker (reuses workerTimeoutMs). */
  frontierTimeoutMs: number
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
    // char.root = players/<name>, parent = players/.
    yield* Effect.try(() =>
      writeCharacterAgentFile({
        playersDir: path.resolve(opts.char.root, ".."),
        playerName: opts.char.name,
        systemPrompt: opts.systemPrompt,
        // Frontmatter `model:` = handle-derived label; agrees with the `-m` label at turn time.
        modelLabel: consciousModelLabel(opts.handle),
      }),
    )
    // Working memory (spec §2 Injection): the project-local opencode.json
    // points `instructions` at me/WM.md. The wm FILES themselves (wm.json/WM.md)
    // are no longer seeded here — that host-side seeding is provisioned eagerly at
    // container startup in apps/roci/src/orchestrator.ts (alongside the `wm` CLI),
    // so this cortex executor holds no dependency on wm (limbic) host code. The
    // seed is idempotent and precedes the first tick, so WM.md exists before the
    // first conscious request. Runs once before the first tick — provisioning, not
    // a lazy in-loop load.
    yield* Effect.try(() =>
      writeCharacterOpencodeConfig({
        playersDir: path.resolve(opts.char.root, ".."),
        playerName: opts.char.name,
      }),
    )
    // Skills (spec §3 Seeding): seed editing-skills + learning idempotently
    // before the first tick — provisioning, not a lazy in-loop load. Never
    // clobbers an existing (agent- or macro-revised) skill file.
    yield* ensureSeedSkills(opts.char)
    // Provision the global in-container provider config (requires Docker).
    yield* provisionConsciousProvider(opts.containerId, opts.handle)
    // Provision the frontier CLI (heavy-lifting delegation tool) into the container.
    yield* provisionFrontierCli(opts.containerId, {
      model: opts.frontierModel,
      timeoutMs: opts.frontierTimeoutMs,
    })
    // NOTE: the in-container `memory` CLI is NO LONGER provisioned here. Core
    // character infrastructure must not be hot-loaded during the active loop, and
    // provisioning it lazily here ran AFTER the spacemolt startup-phase reflection
    // (whose pre-cull promotion hook then `exit 127`d on the missing binary and
    // lost raw diary entries to the dream cull). It is now provisioned eagerly at
    // container startup in apps/roci/src/orchestrator.ts, before any phase runs.
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
