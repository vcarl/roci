import { describe, it, expect } from "vitest"
import type { UnifiedEvent } from "./events.js"
import { rank, classifyLevel, effectiveLevel, passesThreshold, resolveThreshold } from "./levels.js"

const base = { timestamp: "t", character: "c", system: "s", subsystem: "s" }

describe("rank", () => {
  it("orders debug < info < warn < error", () => {
    expect(rank("debug")).toBeLessThan(rank("info"))
    expect(rank("info")).toBeLessThan(rank("warn"))
    expect(rank("warn")).toBeLessThan(rank("error"))
  })
})

describe("classifyLevel", () => {
  it("maps error kind to error", () => {
    expect(classifyLevel({ ...base, kind: "error", message: "x" })).toBe("error")
  })
  it("maps thinking to debug", () => {
    expect(classifyLevel({ ...base, kind: "thinking", text: "x" })).toBe("debug")
  })
  it("maps system/text/tool to info", () => {
    expect(classifyLevel({ ...base, kind: "system", message: "x" })).toBe("info")
    expect(classifyLevel({ ...base, kind: "text", text: "x" })).toBe("info")
    expect(classifyLevel({ ...base, kind: "tool_use", tool: "bash", id: "1", input: {} })).toBe("info")
  })
  it("maps tool_result to info", () => {
    expect(classifyLevel({ ...base, kind: "tool_result", toolUseId: "1", text: "ok" })).toBe("info")
  })
  it("maps subagent_start to info", () => {
    expect(classifyLevel({ ...base, kind: "subagent_start", description: "desc", data: {} })).toBe("info")
  })
  it("maps subagent_stop to info", () => {
    expect(classifyLevel({ ...base, kind: "subagent_stop", data: {} })).toBe("info")
  })
})

describe("effectiveLevel", () => {
  it("prefers an explicit level over the classifier", () => {
    const e: UnifiedEvent = { ...base, kind: "system", message: "x", level: "debug" }
    expect(effectiveLevel(e)).toBe("debug")
  })
  it("falls back to classifyLevel when no level set", () => {
    expect(effectiveLevel({ ...base, kind: "system", message: "x" })).toBe("info")
  })
})

describe("passesThreshold", () => {
  it("passes when level >= threshold", () => {
    expect(passesThreshold("info", "info")).toBe(true)
    expect(passesThreshold("warn", "info")).toBe(true)
  })
  it("blocks when level < threshold", () => {
    expect(passesThreshold("debug", "info")).toBe(false)
  })
})

describe("resolveThreshold", () => {
  it("defaults to info for missing/invalid", () => {
    expect(resolveThreshold(undefined)).toBe("info")
    expect(resolveThreshold("loud")).toBe("info")
  })
  it("accepts valid levels case-insensitively", () => {
    expect(resolveThreshold("DEBUG")).toBe("debug")
    expect(resolveThreshold(" warn ")).toBe("warn")
  })
})
