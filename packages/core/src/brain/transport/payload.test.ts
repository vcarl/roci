import { describe, it, expect } from "vitest"
import {
  selectRuntime,
  buildInnerArgs,
  buildInnerCommand,
  normalizerFor,
  shellEscape,
  openCodeBodyEnv,
  wrapWithTimeout,
  CONTAINER_TIMEOUT_GRACE_SECONDS,
  CONTAINER_TIMEOUT_KILL_AFTER_SECONDS,
} from "./payload.js"
import { normalizeClaude, normalizeOpenCode } from "../../logging/stream-normalizer.js"
import type { TurnConfig } from "./types.js"

const base: TurnConfig = {
  containerId: "c1",
  playerName: "ada",
  systemPrompt: "be good",
  prompt: "do it",
  model: "opus",
  timeoutMs: 1000,
  char: { name: "ada", dir: "/work/players/ada/me" },
  role: "body",
}

describe("selectRuntime", () => {
  it("derives the runtime from the model when no override", () => {
    expect(selectRuntime(base)).toBe("claude")
    expect(selectRuntime({ ...base, model: "openai/gpt-4o" })).toBe("opencode")
  })
  it("honors an explicit runtime override", () => {
    expect(selectRuntime({ ...base, model: "openai/gpt-4o", runtime: "claude" })).toBe("claude")
  })
})

describe("buildInnerArgs (claude)", () => {
  const args = buildInnerArgs(base, "claude")
  it("includes the base claude flags and model", () => {
    expect(args).toContain("-p")
    expect(args).toContain("--model")
    expect(args).toContain("opus")
    expect(args).toContain("--output-format")
    expect(args).toContain("stream-json")
    expect(args).toContain("--verbose")
  })
  it("adds --fallback-model sonnet for non-sonnet models", () => {
    expect(args).toContain("--fallback-model")
    expect(args).toContain("sonnet")
  })
  it("does NOT add --effort low for a body role", () => {
    expect(args).not.toContain("--effort")
  })
  it("escapes and passes the system prompt", () => {
    expect(args).toContain("--system-prompt")
    expect(args).toContain("$'be good'")
  })
})

describe("buildInnerArgs (claude) tool gating", () => {
  it("passes --allowedTools \"\" when noTools", () => {
    const args = buildInnerArgs({ ...base, noTools: true }, "claude")
    const i = args.indexOf("--allowedTools")
    expect(i).toBeGreaterThanOrEqual(0)
    expect(args[i + 1]).toBe("")
  })
  it("joins allowedTools when provided", () => {
    const args = buildInnerArgs({ ...base, allowedTools: ["Bash", "Read"] }, "claude")
    const i = args.indexOf("--allowedTools")
    expect(args[i + 1]).toBe("Bash,Read")
  })
  it("adds --effort low for non-body non-opus roles", () => {
    const args = buildInnerArgs({ ...base, model: "haiku", role: "brain" }, "claude")
    expect(args).toContain("--effort")
    expect(args).toContain("low")
  })
})

describe("buildInnerArgs (opencode)", () => {
  const cfg: TurnConfig = { ...base, model: "openrouter/anthropic/claude-sonnet-4" }
  const args = buildInnerArgs(cfg, "opencode")
  it("uses the opencode base args and omits claude-only flags", () => {
    expect(args).toContain("run")
    expect(args).toContain("--model")
    expect(args).toContain("--format")
    expect(args).toContain("json")
    expect(args).not.toContain("--output-format")
    expect(args).not.toContain("--system-prompt")
  })
})

describe("buildInnerCommand", () => {
  it("prefixes the claude binary name", () => {
    expect(buildInnerCommand(base, "claude").startsWith("claude -p")).toBe(true)
  })
  it("prefixes the opencode binary name", () => {
    const cfg: TurnConfig = { ...base, model: "openai/gpt-4o" }
    expect(buildInnerCommand(cfg, "opencode").startsWith("opencode run")).toBe(true)
  })
})

describe("wrapWithTimeout — in-container self-bounding (issue 3)", () => {
  it("prefixes coreutils timeout with --kill-after and an in-container budget above the host turn budget", () => {
    const inner = "opencode run --format json"
    const wrapped = wrapWithTimeout(inner, 5000)
    // SIGTERM at the budget, SIGKILL backstop --kill-after seconds later.
    expect(wrapped.startsWith(`timeout --kill-after=${CONTAINER_TIMEOUT_KILL_AFTER_SECONDS}s `)).toBe(true)
    // budget = ceil(5000/1000)=5 host seconds + grace → backstop only, host stays primary.
    const expectedBudget = 5 + CONTAINER_TIMEOUT_GRACE_SECONDS
    expect(wrapped).toContain(` ${expectedBudget}s ${inner}`)
  })

  it("leaves the original inner command intact as the timeout target (single foreground process, no pipeline)", () => {
    const inner = "node /home/node/sdk-runner/sdk-runner.mjs"
    expect(wrapWithTimeout(inner, 1000).endsWith(inner)).toBe(true)
  })

  it("never produces a sub-second or zero budget (floors the host seconds at 1)", () => {
    const wrapped = wrapWithTimeout("x", 0)
    expect(wrapped).toContain(` ${1 + CONTAINER_TIMEOUT_GRACE_SECONDS}s x`)
  })
})

describe("normalizerFor", () => {
  it("maps runtimes to their normalizer", () => {
    expect(normalizerFor("claude")).toBe(normalizeClaude)
    expect(normalizerFor("opencode")).toBe(normalizeOpenCode)
  })
})

describe("shellEscape", () => {
  it("wraps in ANSI-C quoting and escapes newlines", () => {
    expect(shellEscape("a\nb")).toBe("$'a\\nb'")
  })
})

describe("openCodeBodyEnv", () => {
  it("disables the models.dev fetch and autoupdate so the locked container falls back to the local provider", () => {
    const env = openCodeBodyEnv(base)
    expect(env.OPENCODE_DISABLE_MODELS_FETCH).toBe("1")
    expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe("1")
  })
  it("preserves any caller-supplied env entries", () => {
    const env = openCodeBodyEnv({ ...base, env: { FOO: "bar" } })
    expect(env.FOO).toBe("bar")
    expect(env.OPENCODE_DISABLE_MODELS_FETCH).toBe("1")
    expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe("1")
  })
})

import { buildOpenCodeSessionCommand } from "./payload.js"

describe("buildOpenCodeSessionCommand", () => {
  const cfg: TurnConfig = { ...base, model: "local/conscious", agentName: "conscious", prompt: "do the thing" }

  it("first turn carries --agent, -m, --format json, and the escaped prompt", () => {
    const cmd = buildOpenCodeSessionCommand(cfg)
    expect(cmd.startsWith("opencode run")).toBe(true)
    expect(cmd).toContain("--format json")
    expect(cmd).toContain("--agent conscious")
    expect(cmd).toContain("-m local/conscious")
    expect(cmd).toContain("$'do the thing'")
  })

  it("first turn passes an explicit --title to suppress opencode's title-gen model call", () => {
    const cmd = buildOpenCodeSessionCommand(cfg)
    expect(cmd).toContain("--title")
    // title is derived from the player name and shell-escaped
    expect(cmd).toContain(`--title $'cortex-${base.playerName}'`)
  })

  it("resume turn carries -s and the prompt but NOT --agent, -m, or --title", () => {
    const cmd = buildOpenCodeSessionCommand({ ...cfg, prompt: "now do this" }, { sessionId: "ses_abc" })
    expect(cmd).toContain("-s ses_abc")
    expect(cmd).toContain("$'now do this'")
    expect(cmd).not.toContain("--agent")
    expect(cmd).not.toContain("-m ")
    expect(cmd).not.toContain("--title")
  })

  it("falls back to the default agent name when none is set", () => {
    const cmd = buildOpenCodeSessionCommand({ ...cfg, agentName: undefined })
    expect(cmd).toContain("--agent conscious")
  })

  it("shell-special-char prompt survives shellEscape inside buildOpenCodeSessionCommand", () => {
    const tricky = `say "hi" and $HOME and \`date\``
    const cmd = buildOpenCodeSessionCommand({ ...cfg, prompt: tricky })
    // The prompt appears inside $'...' ANSI-C quoting
    expect(cmd).toMatch(/\$'.*say "hi".*'/)
    // The $'...' wrapper means dollar sign and backtick are literal (no shell expansion)
    // Confirm the exact escaped form is present in the command string
    expect(cmd).toContain(`$'say "hi" and $HOME and \`date\`'`)
  })
})
