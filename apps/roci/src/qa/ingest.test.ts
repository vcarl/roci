import { describe, it, expect } from "vitest"
import type { BehaviorDigest } from "@roci/core"
import { ingestChunk, initialIngestState } from "./ingest.js"

const line = (message: string) =>
  JSON.stringify({ timestamp: "2026-06-21T00:00:00.000Z", character: "ada", system: "cortex", subsystem: "cortex", kind: "system", message })

const sessionEndLine = (digest: BehaviorDigest) =>
  JSON.stringify({
    timestamp: "2026-06-21T00:00:09.000Z",
    character: "ada",
    system: "orchestrator",
    subsystem: "main",
    kind: "behavior",
    behavior: { type: "session_end", reason: "clean", digest },
  })

describe("ingestChunk", () => {
  it("parses whole lines and ignores blanks", () => {
    const { records } = ingestChunk(initialIngestState, line("hindbrain: escalate 😰") + "\n\n")
    expect(records.map((r) => r.type)).toEqual(["SESSION_START", "ESCALATE"])
  })

  it("surfaces the inline digest from a behavior session_end line", () => {
    const digest: BehaviorDigest = {
      counts: { session_start: 1, session_end: 1 },
      sequence: ["session_start", "session_end"],
      timings: { firstForebrainMs: 1800, firstPlanMs: null },
      startTs: "2026-06-21T00:00:00.000Z",
      terminalCause: "session ended (clean)",
    }
    const { sessionEndDigest } = ingestChunk(initialIngestState, sessionEndLine(digest) + "\n")
    expect(sessionEndDigest?.terminalCause).toBe("session ended (clean)")
    expect(sessionEndDigest?.timings.firstForebrainMs).toBe(1800)
  })

  it("buffers a partial line across two chunks", () => {
    const full = line("forebrain: hold")
    const a = ingestChunk(initialIngestState, full.slice(0, 10))
    expect(a.records).toEqual([])
    const b = ingestChunk(a.state, full.slice(10) + "\n")
    expect(b.records.some((r) => r.type === "FOREBRAIN")).toBe(true)
  })

  it("skips malformed JSON lines without throwing", () => {
    const { records } = ingestChunk(initialIngestState, "not json\n" + line("conscious: plan") + "\n")
    expect(records.some((r) => r.type === "DECISION")).toBe(true)
  })
})
