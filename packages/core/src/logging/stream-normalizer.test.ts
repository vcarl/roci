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
})
