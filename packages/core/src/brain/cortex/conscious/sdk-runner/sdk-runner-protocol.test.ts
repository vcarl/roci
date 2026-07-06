import { describe, it, expect } from "vitest"
import {
  parseCommand,
  toSdkUserMessage,
  statusFromResult,
  formatEventLine,
  formatResultLine,
} from "./sdk-runner-protocol.mjs"

describe("parseCommand", () => {
  it("parses task/steer/end", () => {
    expect(parseCommand('{"v":1,"type":"task","text":"do it"}')).toEqual({ type: "task", text: "do it" })
    expect(parseCommand('{"v":1,"type":"steer","text":"now this"}')).toEqual({ type: "steer", text: "now this" })
    expect(parseCommand('{"v":1,"type":"end"}')).toEqual({ type: "end" })
  })
  it("returns null for blank, invalid JSON, or unknown type", () => {
    expect(parseCommand("")).toBeNull()
    expect(parseCommand("   ")).toBeNull()
    expect(parseCommand("not json")).toBeNull()
    expect(parseCommand('{"v":1,"type":"bogus"}')).toBeNull()
  })
})

describe("toSdkUserMessage", () => {
  it("wraps text as a streaming-input user message", () => {
    expect(toSdkUserMessage("hello")).toEqual({
      type: "user",
      message: { role: "user", content: "hello" },
      parent_tool_use_id: null,
    })
  })
})

describe("statusFromResult", () => {
  it("maps success to completed, everything else to failed", () => {
    expect(statusFromResult({ subtype: "success", is_error: false })).toBe("completed")
    expect(statusFromResult({ subtype: "success", is_error: true })).toBe("failed")
    expect(statusFromResult({ subtype: "error_max_turns", is_error: true })).toBe("failed")
    expect(statusFromResult({ subtype: "error_during_execution", is_error: true })).toBe("failed")
  })
})

describe("formatEventLine / formatResultLine", () => {
  it("wraps an SDK message as an event line", () => {
    const line = formatEventLine({ type: "assistant", message: { content: [] } })
    expect(JSON.parse(line)).toEqual({ v: 1, type: "event", event: { type: "assistant", message: { content: [] } } })
  })
  it("wraps an SDK result as a result line with status + output", () => {
    const line = formatResultLine({ type: "result", subtype: "success", is_error: false, result: "final text" })
    expect(JSON.parse(line)).toEqual({ v: 1, type: "result", status: "completed", output: "final text" })
  })
  it("defaults missing result text to empty string", () => {
    expect(JSON.parse(formatResultLine({ subtype: "success", is_error: false }))).toEqual({
      v: 1, type: "result", status: "completed", output: "",
    })
  })
})
