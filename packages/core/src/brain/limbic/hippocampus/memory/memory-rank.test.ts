import { describe, it, expect } from "vitest"
import type { MemoryHit } from "./longterm-store.js"
import { RERANK_OVERFETCH, reputationWeight, compositeScore, rerank } from "./memory-rank.js"

const hit = (over: Partial<MemoryHit>): MemoryHit => ({
  id: 1, ts: "2026-07-21T12:00:00Z", source: "orient",
  provenance: "inferred", tags: [], text: "t", score: 0.5, ...over,
})

describe("reputationWeight", () => {
  it("orders grounded > episodic > inferred > asserted", () => {
    expect(reputationWeight("grounded")).toBeGreaterThan(reputationWeight("episodic"))
    expect(reputationWeight("episodic")).toBeGreaterThan(reputationWeight("inferred"))
    expect(reputationWeight("inferred")).toBeGreaterThan(reputationWeight("asserted"))
  })
})

describe("compositeScore", () => {
  it("multiplies relevance × reputation", () => {
    // grounded (1.0) × score 0.4 = 0.4 ; asserted (0.45) × 0.4 = 0.18
    expect(compositeScore(hit({ provenance: "grounded", score: 0.4 }))).toBeCloseTo(0.4, 6)
    expect(compositeScore(hit({ provenance: "asserted", score: 0.4 }))).toBeCloseTo(0.18, 6)
  })

  it("guards a non-finite score to 0, regardless of provenance", () => {
    expect(compositeScore(hit({ provenance: "grounded", score: Number.NaN }))).toBe(0)
  })
})

describe("rerank", () => {
  it("a grounded hit outranks an asserted hit at equal relevance", () => {
    const grounded = hit({ id: 1, provenance: "grounded", score: 0.5 })
    const asserted = hit({ id: 2, provenance: "asserted", score: 0.5 })
    expect(rerank([asserted, grounded], 2).map((h) => h.id)).toEqual([1, 2])
  })
  it("relevance still dominates a large trust gap", () => {
    const a = hit({ id: 1, provenance: "asserted", score: 0.95 }) // 0.4275
    const b = hit({ id: 2, provenance: "grounded", score: 0.3 })  // 0.30
    expect(rerank([b, a], 2).map((h) => h.id)).toEqual([1, 2])
  })
  it("truncates to k", () => {
    expect(rerank([hit({ id: 1 }), hit({ id: 2 }), hit({ id: 3 })], 2)).toHaveLength(2)
  })
  it("over-fetch factor is a positive integer > 1", () => {
    expect(Number.isInteger(RERANK_OVERFETCH)).toBe(true)
    expect(RERANK_OVERFETCH).toBeGreaterThan(1)
  })
})
