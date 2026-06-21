// apps/roci/src/qa/baseline.test.ts
import { describe, it, expect } from "vitest"
import type { RunDigest } from "./digest.js"
import { compareBaseline } from "./baseline.js"

const digest = (counts: Record<string, number>): RunDigest => ({
  env: { character: "ada", domain: "spacemolt", tickIntervalMs: 30000, gitSha: "x" },
  counts,
  sequence: [],
  timings: { firstForebrainMs: null, firstPlanMs: null },
  startTs: null,
})

describe("compareBaseline", () => {
  it("reports ok when counts match within tolerance", () => {
    const r = compareBaseline(digest({ FOREBRAIN: 3 }), digest({ FOREBRAIN: 3 }))
    expect(r.ok).toBe(true)
    expect(r.drifts).toEqual([])
  })

  it("flags a missing event class as drift", () => {
    const r = compareBaseline(digest({ DELEGATION: 0 }), digest({ DELEGATION: 2 }))
    expect(r.ok).toBe(false)
    expect(r.drifts[0]).toMatchObject({ field: "count.DELEGATION", baseline: 2, run: 0, note: "missing vs baseline" })
  })

  it("flags a new event class not in the baseline", () => {
    const r = compareBaseline(digest({ CRITICAL: 1 }), digest({}))
    expect(r.drifts[0]).toMatchObject({ field: "count.CRITICAL", note: "new event class" })
  })

  it("respects countTolerance", () => {
    expect(compareBaseline(digest({ ESCALATE: 5 }), digest({ ESCALATE: 6 }), 1).ok).toBe(true)
    expect(compareBaseline(digest({ ESCALATE: 5 }), digest({ ESCALATE: 8 }), 1).ok).toBe(false)
  })
})
