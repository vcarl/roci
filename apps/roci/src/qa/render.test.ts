import { describe, it, expect } from "vitest"
import type { FeedRecord } from "./types.js"
import { renderFeedLine } from "./render.js"

const rec = (over: Partial<FeedRecord>): FeedRecord =>
  ({ ts: "2026-06-21T00:00:00.000Z", kind: "transition", type: "FOREBRAIN", severity: "info", tick: 3, summary: "forebrain: hold", ...over } as FeedRecord)

describe("renderFeedLine", () => {
  it("renders a transition with a bullet and tick", () => {
    expect(renderFeedLine(rec({}))).toBe("• [t3] FOREBRAIN: forebrain: hold")
  })
  it("renders an anomaly with a warning glyph", () => {
    const out = renderFeedLine(rec({ kind: "anomaly", type: "STALL", severity: "warn", summary: "stall — no event in 70s" }))
    expect(out).toBe("⚠ [t3] STALL: stall — no event in 70s")
  })
})
