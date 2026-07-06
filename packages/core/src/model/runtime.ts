import type { ClaudeModel } from "../services/Claude.js"

/** Which agent runtime binary to use inside Docker. */
export type AgentRuntime = "claude" | "opencode"

/** Model string — either a ClaudeModel alias or an OpenCode provider/model string. */
export type AnyModel = ClaudeModel | (string & {})

/** The three Claude tier aliases the `claude` CLI resolves to concrete ids itself. */
const CLAUDE_ALIASES = new Set<string>(["opus", "sonnet", "haiku"])

/**
 * SINGLE SOURCE OF TRUTH for model-string → runtime dispatch. Shared by the
 * dispatch path (`runtimeBinary` / `selectRuntime`) and config-load validation
 * (`assertValidModelConfig` in model-config.ts) so the two can never disagree —
 * the class of silent misroute where a legal override sends a Claude-only turn to
 * the local model (or vice-versa) is structurally impossible.
 *
 * Returns `undefined` for a string that matches NO runtime; callers MUST treat
 * that as an error (fail loudly), never as a fallback. Recognized forms:
 *
 *   - A Claude tier alias — `opus` | `sonnet` | `haiku` → `claude`.
 *   - A fully-qualified Anthropic id — any `claude-*` string (e.g.
 *     `claude-opus-4-6`) → `claude`. DELIBERATE (see docs/MODEL_CONFIG.md): these
 *     are ACCEPTED and routed to the `claude` binary, not rejected, so a config
 *     like `--tier-reasoning claude-opus-4-6` runs on frontier Claude as intended
 *     instead of silently falling to the local model.
 *   - A provider/model string — anything containing `/` (e.g.
 *     `local/mlx-community/gemma-4-31b-it-8bit`, `openrouter/anthropic/...`) →
 *     `opencode`. This is opencode's native `provider/model` addressing; the local
 *     mlx model (dreamCompression) routes here. Checked AFTER the claude-* prefix
 *     is irrelevant because provider ids never begin `claude-`, and an
 *     `openrouter/anthropic/claude-*` id contains `/` so it stays on opencode.
 *
 * Anything else — a bare, provider-less, non-Claude name (`gpt-4o`, `garbage`) —
 * is unrecognized (`undefined`): opencode addresses models as `provider/model`, so
 * a bare name is not a resolvable local model and it is not a Claude model either.
 */
export function modelRuntime(model: AnyModel): AgentRuntime | undefined {
  if (CLAUDE_ALIASES.has(model)) return "claude"
  if (model.startsWith("claude-")) return "claude"
  if (model.includes("/")) return "opencode"
  return undefined
}

/**
 * Determine which runtime binary handles a given model string. Throws on an
 * unrecognized model rather than silently falling back: a config validated at load
 * (`assertValidModelConfig`) never reaches here with an unknown model, so this
 * throw is a defense-in-depth tripwire that converts a would-be silent misroute
 * into a loud failure.
 */
export function runtimeBinary(model: AnyModel): AgentRuntime {
  const runtime = modelRuntime(model)
  if (runtime === undefined) {
    throw new Error(
      `No runtime for model "${model}": expected a Claude alias (opus|sonnet|haiku), ` +
        `a fully-qualified claude-* id, or a provider/model string ` +
        `(e.g. local/mlx-community/gemma-4-31b-it-8bit).`,
    )
  }
  return runtime
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
