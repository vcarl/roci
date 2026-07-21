import { describe, it, expect } from "vitest"
import { normalizeClaude, normalizeOpenCode } from "./stream-normalizer.js"

describe("normalizeClaude", () => {
  it("normalizes system event", () => {
    const events = normalizeClaude({ type: "system", model: "opus" })
    expect(events).toEqual([{ type: "system", model: "opus" }])
  })

  it("normalizes assistant text block", () => {
    const events = normalizeClaude({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] },
    })
    expect(events).toEqual([{ type: "text", text: "hello" }])
  })

  it("normalizes assistant thinking block", () => {
    const events = normalizeClaude({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "hmm" }] },
    })
    expect(events).toEqual([{ type: "thinking", text: "hmm" }])
  })

  it("normalizes assistant tool_use block", () => {
    const events = normalizeClaude({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
      },
    })
    expect(events).toEqual([
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
    ])
  })

  it("normalizes user tool_result block", () => {
    const events = normalizeClaude({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "file.ts" }] },
    })
    expect(events).toEqual([
      { type: "tool_result", toolUseId: "t1", text: "file.ts" },
    ])
  })

  it("normalizes rate_limit_event", () => {
    const events = normalizeClaude({
      type: "rate_limit_event",
      rate_limit_info: { status: "throttled" },
    })
    expect(events).toEqual([{ type: "rate_limit", status: "throttled" }])
  })

  it("returns passthrough for unknown types", () => {
    const events = normalizeClaude({ type: "result" })
    expect(events).toEqual([{ type: "passthrough", rawType: "result" }])
  })

  it("handles multiple content blocks in one assistant event", () => {
    const events = normalizeClaude({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "let me think" },
          { type: "text", text: "here is my answer" },
        ],
      },
    })
    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({ type: "thinking", text: "let me think" })
    expect(events[1]).toEqual({ type: "text", text: "here is my answer" })
  })
})

describe("normalizeOpenCode", () => {
  it("normalizes text event", () => {
    const events = normalizeOpenCode({ type: "text", part: { text: "hello" } })
    expect(events).toEqual([{ type: "text", text: "hello" }])
  })

  it("normalizes reasoning event", () => {
    const events = normalizeOpenCode({ type: "reasoning", part: { text: "thinking..." } })
    expect(events).toEqual([{ type: "thinking", text: "thinking..." }])
  })

  it("extracts tool name and input from the real opencode part shape", () => {
    const events = normalizeOpenCode({
      type: "tool_use",
      part: {
        type: "tool",
        id: "prt_abc",
        tool: "bash",
        callID: "4edb9b0f",
        state: {
          status: "completed",
          input: { command: "ls", description: "list" },
          output: "...",
        },
      },
    })
    expect(events).toEqual([
      { type: "tool_use", id: "prt_abc", name: "bash", input: { command: "ls", description: "list" }, status: "completed" },
      { type: "tool_result", toolUseId: "prt_abc", text: "..." },
    ])
  })

  it("normalizes error event", () => {
    const events = normalizeOpenCode({ type: "error", error: { message: "boom" } })
    expect(events).toEqual([{ type: "error", message: "boom" }])
  })

  it("normalizes step_start as system", () => {
    const events = normalizeOpenCode({ type: "step_start", part: { model: "gpt-4" } })
    expect(events).toEqual([{ type: "system", model: "gpt-4" }])
  })

  it("ignores step_finish", () => {
    const events = normalizeOpenCode({ type: "step_finish" })
    expect(events).toEqual([])
  })

  it("extracts status and durationMs from a completed tool state", () => {
    const events = normalizeOpenCode({
      type: "tool_use",
      part: {
        id: "prt_1",
        tool: "bash",
        state: { status: "completed", input: { command: "ls" }, output: "...", time: { start: 100, end: 350 } },
      },
    })
    expect(events).toEqual([
      { type: "tool_use", id: "prt_1", name: "bash", input: { command: "ls" }, status: "completed", durationMs: 250 },
      { type: "tool_result", toolUseId: "prt_1", text: "..." },
    ])
  })

  it("omits status/durationMs when the tool state carries none", () => {
    const events = normalizeOpenCode({ type: "tool_use", part: { id: "p", tool: "read", state: { input: {} } } })
    expect(events).toEqual([{ type: "tool_use", id: "p", name: "read", input: {} }])
  })

  it("emits a tool_result alongside tool_use when a completed state carries output", () => {
    const events = normalizeOpenCode({
      type: "tool_use",
      part: {
        id: "prt_9",
        tool: "spacemolt",
        state: { status: "completed", input: { cmd: "refuel" }, output: "fuel=100%" },
      },
    })
    expect(events).toEqual([
      { type: "tool_use", id: "prt_9", name: "spacemolt", input: { cmd: "refuel" }, status: "completed" },
      { type: "tool_result", toolUseId: "prt_9", text: "fuel=100%" },
    ])
  })

  it("emits a tool_result for an errored tool state", () => {
    const events = normalizeOpenCode({
      type: "tool_use",
      part: { id: "prt_e", tool: "bash", state: { status: "error", input: {}, output: "command failed" } },
    })
    expect(events).toContainEqual({ type: "tool_result", toolUseId: "prt_e", text: "command failed" })
  })

  it("does not emit a tool_result for a non-terminal (running) tool state", () => {
    const events = normalizeOpenCode({
      type: "tool_use",
      part: { id: "prt_r", tool: "bash", state: { status: "running", input: {} } },
    })
    expect(events).toEqual([{ type: "tool_use", id: "prt_r", name: "bash", input: {}, status: "running" }])
  })

  // ── Hardening: gracefully handle ALL log output from OpenCode ──────────────
  it("surfaces an unknown event type as a passthrough (never silently dropped)", () => {
    const events = normalizeOpenCode({ type: "totally_new_kind", part: {} })
    expect(events).toEqual([{ type: "passthrough", rawType: "totally_new_kind" }])
  })

  it("passes through a missing/non-string event type as 'unknown'", () => {
    expect(normalizeOpenCode({ part: {} })).toEqual([{ type: "passthrough", rawType: "unknown" }])
    expect(normalizeOpenCode({ type: 42 } as Record<string, unknown>)).toEqual([
      { type: "passthrough", rawType: "unknown" },
    ])
  })

  it("does not throw on a non-object line (bare value survived JSON.parse)", () => {
    expect(() => normalizeOpenCode(5 as unknown as Record<string, unknown>)).not.toThrow()
    expect(normalizeOpenCode("str" as unknown as Record<string, unknown>)).toEqual([
      { type: "passthrough", rawType: "unknown" },
    ])
  })

  it("does not throw when a tool_use is missing its state / part entirely", () => {
    expect(normalizeOpenCode({ type: "tool_use" })).toEqual([{ type: "tool_use", id: "", name: "", input: {} }])
    expect(normalizeOpenCode({ type: "tool_use", part: { id: "p", tool: "bash" } })).toEqual([
      { type: "tool_use", id: "p", name: "bash", input: {} },
    ])
  })

  it("does not throw when tool state fields are the wrong type", () => {
    const events = normalizeOpenCode({
      type: "tool_use",
      part: { id: "p", tool: "bash", state: { status: "completed", input: "not-an-object", time: "nope", output: 7 } },
    })
    // input coerced to {}, no durationMs (time not an object), output stringified.
    expect(events).toEqual([
      { type: "tool_use", id: "p", name: "bash", input: {}, status: "completed" },
      { type: "tool_result", toolUseId: "p", text: "7" },
    ])
  })

  it("extracts a numeric exit code from state.metadata.exit", () => {
    const [toolUse] = normalizeOpenCode({
      type: "tool_use",
      part: { id: "p", tool: "bash", state: { status: "error", input: {}, output: "boom", metadata: { exit: 2 } } },
    })
    expect(toolUse).toMatchObject({ type: "tool_use", exitCode: 2 })
  })

  it("names the error class on a failed tool state that carries state.error", () => {
    const [toolUse] = normalizeOpenCode({
      type: "tool_use",
      part: { id: "p", tool: "bash", state: { status: "error", input: {}, output: "x", error: { name: "TimeoutError" } } },
    })
    expect(toolUse).toMatchObject({ exitCode: "TimeoutError" })
  })

  it("omits exitCode when the state exposes no code and no named error", () => {
    const [toolUse] = normalizeOpenCode({
      type: "tool_use",
      part: { id: "p", tool: "bash", state: { status: "error", input: {}, output: "plain failure" } },
    })
    expect(toolUse).not.toHaveProperty("exitCode")
  })

  it("does not throw on a malformed error event (missing error object)", () => {
    expect(normalizeOpenCode({ type: "error" })).toEqual([{ type: "error", message: "unknown error" }])
  })
})
