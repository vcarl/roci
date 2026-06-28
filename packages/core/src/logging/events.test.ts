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
