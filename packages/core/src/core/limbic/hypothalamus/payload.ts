import type { TurnConfig } from "./types.js"
import { runtimeBinary, runtimeBaseArgs, type AgentRuntime } from "./runtime.js"
import {
  normalizeClaude,
  normalizeOpenCode,
  type InternalEvent,
} from "../../../logging/stream-normalizer.js"
import { CONSCIOUS_AGENT_NAME } from "../../../conscious/opencode-config.js"

/** Shell-safe literal using $'...' ANSI-C quoting. */
export function shellEscape(s: string): string {
  let escaped = ""
  for (const ch of s) {
    const code = ch.charCodeAt(0)
    if (ch === "\\") escaped += "\\\\"
    else if (ch === "'") escaped += "\\'"
    else if (ch === "\n") escaped += "\\n"
    else if (ch === "\r") escaped += "\\r"
    else if (ch === "\t") escaped += "\\t"
    else if (code < 0x20 || code === 0x7f) escaped += `\\x${code.toString(16).padStart(2, "0")}`
    else escaped += ch
  }
  return `$'${escaped}'`
}

/** Which runtime this turn uses: explicit override, else model-derived. */
export function selectRuntime(config: TurnConfig): AgentRuntime {
  return config.runtime ?? runtimeBinary(config.model)
}

/** The normalizer matching a runtime's stdout format. */
export function normalizerFor(
  runtime: AgentRuntime,
): (raw: Record<string, unknown>) => InternalEvent[] {
  return runtime === "opencode" ? normalizeOpenCode : normalizeClaude
}

/**
 * Build the args (after the binary name) for the inner command run *inside* the
 * container. This is the swappable "payload" — the transport (docker exec) is
 * identical regardless of which payload runs.
 */
export function buildInnerArgs(config: TurnConfig, runtime: AgentRuntime): string[] {
  const args: string[] = [...runtimeBaseArgs(runtime, config.model)]

  if (runtime === "claude") {
    if (config.model !== "sonnet") {
      args.push("--fallback-model", "sonnet")
    }
    args.push("--output-format", "stream-json")
    args.push("--verbose")

    // Brain (opus) uses full effort; body needs normal effort for multi-step
    // workflows; only apply low effort to non-body, non-opus roles.
    if (config.model !== "opus" && config.role !== "body") {
      args.push("--effort", "low")
    }

    if (config.maxBudgetUsd) {
      args.push("--max-budget-usd", String(config.maxBudgetUsd))
    }
  }

  // Tool access control
  if (config.noTools) {
    if (runtime === "claude") {
      args.push("--allowedTools", "")
    }
    // OpenCode: no tools by default in run mode unless explicitly declared.
  } else {
    if (config.allowedTools && config.allowedTools.length > 0) {
      args.push("--allowedTools", config.allowedTools.join(","))
    }
    if (config.disallowedTools && config.disallowedTools.length > 0) {
      args.push("--disallowedTools", config.disallowedTools.join(","))
    }
  }

  if (config.addDirs) {
    for (const dir of config.addDirs) {
      args.push("--add-dir", dir)
    }
  }

  if (config.systemPrompt) {
    if (runtime === "claude") {
      args.push("--system-prompt", shellEscape(config.systemPrompt))
    }
    // OpenCode: system prompt handling TBD — prepend to prompt (future).
  }

  return args
}

/** The full inner command string: `<binary> <args>`. */
export function buildInnerCommand(config: TurnConfig, runtime: AgentRuntime): string {
  const binary = runtime === "claude" ? "claude" : "opencode"
  return `${binary} ${buildInnerArgs(config, runtime).join(" ")}`
}

/**
 * Inner command for a conscious-tier OpenCode session turn. First turn opens the
 * session with the project-local agent and model; a resume turn continues an
 * existing session by id (and must NOT re-pass --agent/-m — the session carries
 * that context). `-s <id>` only; `--continue` is never used (orchestration-unsafe).
 */
export function buildOpenCodeSessionCommand(
  config: TurnConfig,
  resume?: { sessionId: string },
): string {
  const parts = ["opencode", "run", "--format", "json"]
  if (resume) {
    parts.push("-s", resume.sessionId)
  } else {
    parts.push("--agent", config.agentName ?? CONSCIOUS_AGENT_NAME)
    parts.push("-m", String(config.model))
  }
  parts.push(shellEscape(config.prompt))
  return parts.join(" ")
}
