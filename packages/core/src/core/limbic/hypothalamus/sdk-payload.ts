import type { TurnConfig } from "./types.js"

/** Where the SDK runner is installed inside the container image (Task 7). */
export const SDK_RUNNER_PATH = "/home/node/sdk-runner/sdk-runner.mjs"

/** Default max agentic turns for a single SDK session. */
const DEFAULT_SDK_MAX_TURNS = 40

/** The inner command run inside the container: the SDK runner, no flags. */
export function buildSdkInnerCommand(): string {
  return `node ${SDK_RUNNER_PATH}`
}

/** A single host→runner `task` NDJSON line (no trailing newline). */
export function taskLine(text: string): string {
  return JSON.stringify({ v: 1, type: "task", text })
}

/** A single host→runner `steer` NDJSON line (no trailing newline). */
export function steerLine(text: string): string {
  return JSON.stringify({ v: 1, type: "steer", text })
}

/** The host→runner `end` control NDJSON line (no trailing newline). */
export function endLine(): string {
  return JSON.stringify({ v: 1, type: "end" })
}

/**
 * The NDJSON stdin for a run-to-completion SDK turn: one `task`, then `end`.
 * Phase 2 never emits `steer` (that is Phase 3).
 */
export function buildSdkStdin(task: string): string {
  return `${taskLine(task)}\n${endLine()}\n`
}

/**
 * Env the runner reads (it takes no CLI flags). The host sets these on the
 * `docker exec`. `ROCI_SDK_MODEL` carries `config.model` verbatim — the Task 1
 * auth spike confirmed the SDK accepts the sonnet/opus/haiku aliases, so no
 * alias-to-id mapping is needed. `config.env` is merged first; the `ROCI_SDK_*`
 * keys always take precedence so callers cannot override the protocol env.
 */
export function sdkEnv(config: TurnConfig): Record<string, string> {
  return {
    ...(config.env ?? {}),
    ROCI_SDK_MODEL: config.model,
    ROCI_SDK_SYSTEM_PROMPT: config.systemPrompt,
    ROCI_SDK_MAX_TURNS: String(DEFAULT_SDK_MAX_TURNS),
  }
}
