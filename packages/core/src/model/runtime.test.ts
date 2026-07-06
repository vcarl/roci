import { describe, it, expect } from "vitest"
import { runtimeBinary, runtimeBaseArgs, modelRuntime } from "./runtime.js"

describe("modelRuntime (single source of truth)", () => {
  it("maps the three Claude tier aliases to the claude runtime", () => {
    expect(modelRuntime("opus")).toBe("claude")
    expect(modelRuntime("sonnet")).toBe("claude")
    expect(modelRuntime("haiku")).toBe("claude")
  })

  it("maps a fully-qualified claude-* id to the claude runtime (deliberate: accepted, routed to claude)", () => {
    // Regression for the misroute bug: `--tier-reasoning claude-opus-4-6` MUST run
    // on frontier Claude, not silently fall to the local model.
    expect(modelRuntime("claude-opus-4-6")).toBe("claude")
    expect(modelRuntime("claude-sonnet-4-5")).toBe("claude")
    expect(modelRuntime("claude-3-5-haiku-latest")).toBe("claude")
  })

  it("maps a provider/model string to the opencode runtime", () => {
    expect(modelRuntime("local/mlx-community/gemma-4-31b-it-8bit")).toBe("opencode")
    expect(modelRuntime("openrouter/anthropic/claude-sonnet-4")).toBe("opencode")
    expect(modelRuntime("openai/gpt-4o")).toBe("opencode")
  })

  it("claude-* prefix wins over the slash rule (precedence lock)", () => {
    // Intended precedence: a string that BEGINS `claude-` routes to the claude
    // binary even if it also contains a slash — the prefix check runs first. The
    // real-world negative stays on opencode: a provider-prefixed Anthropic id
    // (`openrouter/anthropic/claude-*`) starts with its provider, not `claude-`.
    expect(modelRuntime("claude-foo/bar")).toBe("claude")
    expect(modelRuntime("openrouter/anthropic/claude-sonnet-4")).toBe("opencode")
  })

  it("returns undefined for a bare, provider-less non-Claude name (unknown → config error)", () => {
    // opencode addresses models as provider/model, so a bare name resolves to no
    // runtime. The caller (config validation / runtimeBinary) must fail loudly,
    // never fall back.
    expect(modelRuntime("gpt-4o")).toBeUndefined()
    expect(modelRuntime("totally-made-up")).toBeUndefined()
    expect(modelRuntime("")).toBeUndefined()
  })
})

describe("runtimeBinary", () => {
  it("returns 'claude' for anthropic models and fully-qualified claude-* ids", () => {
    expect(runtimeBinary("opus")).toBe("claude")
    expect(runtimeBinary("sonnet")).toBe("claude")
    expect(runtimeBinary("haiku")).toBe("claude")
    expect(runtimeBinary("claude-opus-4-6")).toBe("claude")
  })

  it("returns 'opencode' for provider/model strings", () => {
    expect(runtimeBinary("openrouter/anthropic/claude-sonnet-4")).toBe("opencode")
    expect(runtimeBinary("openai/gpt-4o")).toBe("opencode")
  })

  it("routes the local conscious-tier dream-compression model to opencode", () => {
    expect(runtimeBinary("local/mlx-community/gemma-4-31b-it-8bit")).toBe("opencode")
  })

  it("throws (never silently falls back) for an unrecognized model", () => {
    // Defense-in-depth tripwire: a validated config never reaches here with an
    // unknown model; if one does, fail loudly instead of misrouting.
    expect(() => runtimeBinary("gpt-4o")).toThrow(/no runtime/i)
  })
})

describe("runtimeBaseArgs", () => {
  it("returns claude base args for claude runtime", () => {
    const args = runtimeBaseArgs("claude", "opus")
    expect(args).toContain("-p")
    expect(args).not.toContain("--bare")
    expect(args).toContain("--permission-mode")
    expect(args).toContain("bypassPermissions")
    expect(args).toContain("--model")
    expect(args).toContain("opus")
  })

  it("returns opencode base args for opencode runtime", () => {
    const args = runtimeBaseArgs("opencode", "openrouter/anthropic/claude-sonnet-4")
    expect(args).toContain("run")
    expect(args).toContain("--model")
    expect(args).toContain("openrouter/anthropic/claude-sonnet-4")
    expect(args).toContain("--format")
    expect(args).toContain("json")
  })
})
