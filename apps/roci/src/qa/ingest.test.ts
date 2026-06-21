import { describe, it, expect } from "vitest"
import { ingestChunk, initialIngestState } from "./ingest.js"

const line = (message: string) =>
  JSON.stringify({ timestamp: "2026-06-21T00:00:00.000Z", character: "ada", system: "cortex", subsystem: "cortex", kind: "system", message })

describe("ingestChunk", () => {
  it("parses whole lines and ignores blanks", () => {
    const { records } = ingestChunk(initialIngestState, line("hindbrain: escalate 😰") + "\n\n")
    expect(records.map((r) => r.type)).toEqual(["SESSION_START", "ESCALATE"])
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
