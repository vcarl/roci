import { describe, it, expect } from "vitest"
import { runtimeBinary, runtimeBaseArgs } from "./runtime.js"

describe("runtimeBinary", () => {
  it("returns 'claude' for anthropic models", () => {
    expect(runtimeBinary("opus")).toBe("claude")
    expect(runtimeBinary("sonnet")).toBe("claude")
    expect(runtimeBinary("haiku")).toBe("claude")
  })

  it("returns 'opencode' for non-anthropic models", () => {
    expect(runtimeBinary("openrouter/anthropic/claude-sonnet-4")).toBe("opencode")
    expect(runtimeBinary("gpt-4o")).toBe("opencode")
  })
})

describe("runtimeBaseArgs", () => {
  it("returns claude base args for claude runtime", () => {
    const args = runtimeBaseArgs("claude", "opus")
    expect(args).toContain("-p")
    expect(args).toContain("--bare")
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
