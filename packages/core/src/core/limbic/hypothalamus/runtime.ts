import type { ClaudeModel } from "../../../services/Claude.js"

/** Which agent runtime binary to use inside Docker. */
export type AgentRuntime = "claude" | "opencode"

/** Model string — either a ClaudeModel alias or an OpenCode provider/model string. */
export type AnyModel = ClaudeModel | (string & {})

const CLAUDE_MODELS = new Set<string>(["opus", "sonnet", "haiku"])

/** Determine which runtime binary handles a given model string. */
export function runtimeBinary(model: AnyModel): AgentRuntime {
  return CLAUDE_MODELS.has(model) ? "claude" : "opencode"
}

/**
 * Base CLI args for the selected runtime.
 * Claude: `claude -p --permission-mode bypassPermissions --model <model>`
 * OpenCode: `opencode run --format json --model <model>`
 * Note: --bare is NOT used because it disables OAuth token resolution.
 */
export function runtimeBaseArgs(runtime: AgentRuntime, model: AnyModel): string[] {
  if (runtime === "claude") {
    return ["-p", "--permission-mode", "bypassPermissions", "--model", model]
  }
  return ["run", "--format", "json", "--model", model]
}
