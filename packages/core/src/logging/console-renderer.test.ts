import { describe, it, expect } from "vitest"
import type { UnifiedEvent } from "./events.js"
import type { Behavior } from "./behavior.js"
import { renderEvent } from "./console-renderer.js"

const ev = (behavior: Behavior): UnifiedEvent => ({
  timestamp: "2026-06-30T00:00:00.000Z",
  character: "ada",
  system: "orchestrator",
  subsystem: "main",
  kind: "behavior",
  behavior,
})

// Strip ANSI so assertions match the rendered text content.
const plain = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))

describe("renderEvent — behavior", () => {
  it("renders a phase behavior on one tagged line", () => {
    const lines = plain(renderEvent(ev({ type: "phase", phase: "active", transition: "enter" })))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe("[ada:main] phase active enter")
  })

  it("renders a provision behavior with component and status", () => {
    const lines = plain(renderEvent(ev({ type: "provision", component: "memory_cli", status: "ready" })))
    expect(lines[0]).toBe("[ada:main] provision memory_cli ready")
  })

  it("renders a reflection promote with its count", () => {
    const lines = plain(renderEvent(ev({ type: "reflection", stage: "promote", status: "done", counts: { promoted: 0 } })))
    expect(lines[0]).toContain("reflection promote done")
    expect(lines[0]).toContain("promoted=0")
  })

  it("renders a session_end with reason", () => {
    const lines = plain(renderEvent(ev({
      type: "session_end",
      reason: "signal",
      signal: "SIGTERM",
      digest: { counts: {}, sequence: [], timings: { firstForebrainMs: null, firstPlanMs: null }, startTs: null, terminalCause: null },
    })))
    expect(lines[0]).toBe("[ada:main] session_end signal (SIGTERM)")
  })

  it("renders a note with its label", () => {
    const lines = plain(renderEvent(ev({ type: "note", label: "opencode-blob", severity: "warn" })))
    expect(lines[0]).toContain("note opencode-blob")
  })
})
