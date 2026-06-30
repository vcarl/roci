import { describe, it, expect } from "vitest"
import type { Behavior } from "./behavior.js"
import type { UnifiedEvent } from "./events.js"
import { effectiveLevel } from "./levels.js"

const behaviorEvent = (behavior: Behavior): UnifiedEvent => ({
  timestamp: "2026-06-30T00:00:00.000Z",
  character: "ada",
  system: "orchestrator",
  subsystem: "main",
  kind: "behavior",
  behavior,
})

describe("behavior event level classification", () => {
  it("classifies a machinery behavior at info", () => {
    const ev = behaviorEvent({ type: "phase", phase: "active", transition: "enter" })
    expect(effectiveLevel(ev)).toBe("info")
  })

  it("classifies a failed provision at warn", () => {
    const ev = behaviorEvent({ type: "provision", component: "memory_cli", status: "failed", detail: "exit 127" })
    expect(effectiveLevel(ev)).toBe("warn")
  })

  it("classifies an error-reason session_end at warn", () => {
    const ev = behaviorEvent({
      type: "session_end",
      reason: "error",
      digest: { counts: {}, sequence: [], timings: { firstForebrainMs: null, firstPlanMs: null }, startTs: null, terminalCause: null },
    })
    expect(effectiveLevel(ev)).toBe("warn")
  })

  it("honors a note's explicit severity", () => {
    const ev = behaviorEvent({ type: "note", label: "weird", severity: "error" })
    expect(effectiveLevel(ev)).toBe("error")
  })

  it("defaults a note with no severity to info", () => {
    const ev = behaviorEvent({ type: "note", label: "fyi" })
    expect(effectiveLevel(ev)).toBe("info")
  })
})
