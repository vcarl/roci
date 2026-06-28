import { describe, it, expect } from "vitest"
import { toUnifiedEvents } from "./events.js"
import { renderEvent } from "./console-renderer.js"

describe("toUnifiedEvents level assignment", () => {
  it("marks opencode init (system) as debug", () => {
    const [e] = toUnifiedEvents([{ type: "system" }], "c", "body", "opencode")
    expect(e.level).toBe("debug")
  })
  it("marks passthrough as debug", () => {
    const [e] = toUnifiedEvents([{ type: "passthrough", rawType: "weird" }], "c", "body", "opencode")
    expect(e.level).toBe("debug")
  })
  it("marks rate_limit as warn", () => {
    const [e] = toUnifiedEvents([{ type: "rate_limit", status: "throttled" }], "c", "body", "claude")
    expect(e.level).toBe("warn")
  })
})

describe("renderEvent visibility", () => {
  const base = { timestamp: "t", character: "c", system: "s", subsystem: "s" }
  it("does not dim errors and adds an error marker", () => {
    const out = renderEvent({ ...base, kind: "error", message: "boom" }).join("")
    expect(out).toContain("✖")
    expect(out).not.toContain("\x1b[2m") // no DIM
  })
  it("adds a warn marker for warn-level events", () => {
    const out = renderEvent({ ...base, kind: "system", message: "parse failure", level: "warn" }).join("")
    expect(out).toContain("⚠")
  })
})

describe("exchange rendering", () => {
  it("renders an exchange as a compact one-liner (sizes, not full content)", () => {
    const out = renderEvent({
      timestamp: "t", character: "c", system: "cortex", subsystem: "orient",
      kind: "exchange", channel: "cortex", step: "orient",
      prompt: "x".repeat(1200), response: "y".repeat(9000),
    }).join("\n")
    expect(out).toContain("orient")
    expect(out).toContain("prompt=1200c")
    expect(out).toContain("resp=9000c")
    expect(out).not.toContain("yyyy") // full response must NOT appear on console
  })
})

describe("rate_limit end-to-end rendering", () => {
  it("renders rate_limit with ⚠ and message, no error: or ✖", () => {
    const [e] = toUnifiedEvents([{ type: "rate_limit", status: "throttled" }], "c", "body", "claude")
    const out = renderEvent(e).join("")
    expect(out).toContain("⚠")
    expect(out).toContain("rate_limit: throttled")
    expect(out).not.toContain("error:")
    expect(out).not.toContain("✖")
  })
})

describe("console line truncation", () => {
  it("truncates a long system line for console but leaves the stored event full", () => {
    const long = "Z".repeat(2000)
    const event = { timestamp: "t", character: "c", system: "cortex", subsystem: "cortex", kind: "system" as const, message: `raw output: ${long}` }
    const out = renderEvent(event).join("\n")
    expect(out).toContain("… (") // truncation marker present
    expect(out).toContain("full in events.jsonl")
    expect(out.length).toBeLessThan(1200) // console line is shortened
    expect(event.message).toBe(`raw output: ${long}`) // stored event UNCHANGED
  })

  it("does not truncate a short system line", () => {
    const event = { timestamp: "t", character: "c", system: "s", subsystem: "s", kind: "system" as const, message: "short message" }
    expect(renderEvent(event).join("\n")).toContain("short message")
    expect(renderEvent(event).join("\n")).not.toContain("…")
  })
})
