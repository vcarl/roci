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

  if (runtime === "opencode") {
    // Provide an explicit session title so opencode does NOT fire its automatic
    // title-generation call. That call hits the single-request local model server
    // CONCURRENTLY with the main turn; the two concurrent requests wedge the
    // resident model and the turn stalls for the full timeout. An explicit --title
    // suppresses the title call, leaving exactly one request to the model.
    args.push("--title", shellEscape(`turn-${config.playerName}`))
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

  // --add-dir is a claude-only flag; opencode `run` may reject it. Dream/noTools
  // turns don't need extra dirs anyway, so gate the loop to the claude runtime.
  if (runtime === "claude" && config.addDirs) {
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
 * Issue 3: seconds added to the host turn budget for the in-container backstop.
 * The in-container `timeout` budget is set ABOVE the host wall-clock timeout so
 * the host transport timeout stays primary (observable timeout behavior is
 * unchanged); the in-container `timeout` only reaps a process the host has
 * abandoned. `docker exec` does NOT signal-forward the death of its host-side
 * client to the in-container process, so without this an interrupted/timed-out
 * turn orphans the agent inside the container (CPU/RAM + a held model-server
 * connection). This bounds that orphan's lifetime to budget + kill-after.
 */
export const CONTAINER_TIMEOUT_GRACE_SECONDS = 60

/**
 * Seconds between `timeout`'s SIGTERM and its SIGKILL backstop (`--kill-after`).
 * SIGTERM lets the agent shut down cleanly; SIGKILL guarantees death even if the
 * agent ignores SIGTERM. The inner command is always a single foreground process
 * (claude / opencode / node sdk-runner) — `timeout`'s direct child — so the
 * signal reaches the agent directly with no intervening pipeline.
 */
export const CONTAINER_TIMEOUT_KILL_AFTER_SECONDS = 10

/**
 * Wrap an inner command so it self-terminates inside the container at a wall-clock
 * budget, independent of the host. Uses coreutils `timeout` (always present on the
 * Debian `node:20` image). The budget is the host turn seconds plus a grace margin,
 * so it is a backstop, not the primary timeout. See CONTAINER_TIMEOUT_GRACE_SECONDS.
 */
export function wrapWithTimeout(innerCmd: string, timeoutMs: number): string {
  const hostSeconds = Math.max(1, Math.ceil(timeoutMs / 1000))
  const budgetSeconds = hostSeconds + CONTAINER_TIMEOUT_GRACE_SECONDS
  return `timeout --kill-after=${CONTAINER_TIMEOUT_KILL_AFTER_SECONDS}s ${budgetSeconds}s ${innerCmd}`
}

/**
 * Env vars the opencode body invocation needs inside the network-locked container.
 *
 * opencode otherwise tries to fetch its model registry from
 * https://models.dev/api.json at startup; the container firewall blocks that host,
 * so the call hangs and opencode never falls back to the fully-configured, reachable
 * local provider. opencode checks OPENCODE_DISABLE_MODELS_FETCH *before* any network
 * call and proceeds with an empty registry + the explicitly-configured local
 * provider/model. OPENCODE_DISABLE_AUTOUPDATE suppresses a second outbound call.
 */
export const OPENCODE_DISABLE_NETWORK_ENV: Record<string, string> = {
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
}

/**
 * Assemble the env for an opencode body/session exec: caller-supplied env plus the
 * network-disabling vars above. Flows through buildExecArgs as `-e KEY=VAL` flags,
 * so it takes effect at docker-exec time with no container rebuild.
 */
export function openCodeBodyEnv(config: TurnConfig): Record<string, string> {
  return { ...config.env, ...OPENCODE_DISABLE_NETWORK_ENV }
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
    // Provide an explicit session title so opencode does NOT fire its automatic
    // title-generation ("small model") call. That call hits the same single-request
    // local model server CONCURRENTLY with the main agent call; on the large resident
    // model the two concurrent requests wedge it (0% CPU, both hang) and the body
    // stalls for the full turn timeout. An explicit --title suppresses the title call
    // entirely, leaving exactly one request to the model. Only the first turn creates
    // (and names) the session, so resume turns don't need it.
    parts.push("--title", shellEscape(`cortex-${config.playerName}`))
  }
  parts.push(shellEscape(config.prompt))
  return parts.join(" ")
}
