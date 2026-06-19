import { describe, it, expect } from "vitest"
import { selectRuntime, buildInnerArgs, buildInnerCommand, normalizerFor, shellEscape } from "./payload.js"
import { normalizeClaude, normalizeOpenCode } from "../../../logging/stream-normalizer.js"
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
    expect(selectRuntime({ ...base, model: "gpt-4o" })).toBe("opencode")
  })
  it("honors an explicit runtime override", () => {
    expect(selectRuntime({ ...base, model: "gpt-4o", runtime: "claude" })).toBe("claude")
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
    const cfg: TurnConfig = { ...base, model: "gpt-4o" }
    expect(buildInnerCommand(cfg, "opencode").startsWith("opencode run")).toBe(true)
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
