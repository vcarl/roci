import { describe, it, expect } from "vitest"
import { normalizeClaude, normalizeOpenCode, normalizeSdk } from "./stream-normalizer.js"

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
      { type: "tool_use", id: "prt_abc", name: "bash", input: { command: "ls", description: "list" } },
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
})

describe("normalizeSdk", () => {
  it("unwraps an event line's assistant text blocks", () => {
    const raw = {
      v: 1,
      type: "event",
      event: { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } },
    }
    expect(normalizeSdk(raw)).toEqual([{ type: "text", text: "hello" }])
  })
  it("maps assistant thinking and tool_use blocks", () => {
    const raw = {
      type: "event",
      event: {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
          ],
        },
      },
    }
    expect(normalizeSdk(raw)).toEqual([
      { type: "thinking", text: "hmm" },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
    ])
  })
  it("maps a system event to a system InternalEvent", () => {
    const raw = { type: "event", event: { type: "system", subtype: "init", model: "claude-sonnet" } }
    expect(normalizeSdk(raw)).toEqual([{ type: "system", model: "claude-sonnet" }])
  })
  it("maps a rate_limit_event to a rate_limit InternalEvent (spike observed this in-stream)", () => {
    const raw = { type: "event", event: { type: "rate_limit_event", rate_limit_info: { status: "allowed" } } }
    expect(normalizeSdk(raw)).toEqual([{ type: "rate_limit", status: "allowed" }])
  })
  it("returns [] for the terminal result line (output captured via accumulated text)", () => {
    expect(normalizeSdk({ type: "result", status: "completed", output: "done" })).toEqual([])
    expect(normalizeSdk({ type: "event", event: { type: "result", subtype: "success", result: "done" } })).toEqual([])
  })
  it("passes through unknown event types", () => {
    expect(normalizeSdk({ type: "event", event: { type: "weird_thing" } })).toEqual([
      { type: "passthrough", rawType: "weird_thing" },
    ])
  })
  it("falls back to 'unknown' rawType for typeless events and content blocks (matches normalizeClaude)", () => {
    expect(normalizeSdk({ type: "event", event: {} })).toEqual([{ type: "passthrough", rawType: "unknown" }])
    expect(
      normalizeSdk({ type: "event", event: { type: "assistant", message: { content: [{}] } } }),
    ).toEqual([{ type: "passthrough", rawType: "unknown" }])
  })
  it("returns [] for malformed lines", () => {
    expect(normalizeSdk({ foo: "bar" })).toEqual([])
  })
})
