import { describe, it, expect } from "vitest"
import type { MemoryHit } from "./longterm-store.js"
import {
  RERANK_OVERFETCH,
  reputationWeight,
  compositeScore,
  rerank,
  salienceWeight,
  halfLife,
  recency,
  HALF_LIFE_MIN,
  HALF_LIFE_MAX,
  NEUTRAL_SALIENCE,
} from "./memory-rank.js"

const NOW = Date.parse("2026-07-22T00:00:00Z")

const hit = (over: Partial<MemoryHit>): MemoryHit => ({
  id: 1, ts: new Date(NOW).toISOString(), source: "orient",
  provenance: "inferred", tags: [], text: "t", score: 0.5, ...over,
})

describe("reputationWeight (Phase 1, unchanged)", () => {
  it("orders grounded > episodic > inferred > asserted", () => {
    expect(reputationWeight("grounded")).toBeGreaterThan(reputationWeight("episodic"))
    expect(reputationWeight("episodic")).toBeGreaterThan(reputationWeight("inferred"))
    expect(reputationWeight("inferred")).toBeGreaterThan(reputationWeight("asserted"))
  })
})

describe("salienceWeight", () => {
  it("empty dims → NEUTRAL_SALIENCE", () => {
    expect(salienceWeight(hit({ dims: {} }), { safety: 1 })).toBe(NEUTRAL_SALIENCE)
  })
  it("absent dims → NEUTRAL_SALIENCE", () => {
    expect(salienceWeight(hit({}), { safety: 1 })).toBe(NEUTRAL_SALIENCE)
  })
  it("single-drive dims = salience[drive] × (weight/5) — the character's caring matters", () => {
    // safety hit at 0.8 (=4/5); a character who cares 0.5 → 0.4
    expect(salienceWeight(hit({ dims: { safety: 0.8 } }), { safety: 0.5, agency: 0.3 })).toBeCloseTo(0.4, 6)
    // the SAME memory is more salient to a character who cares more (0.9 → 0.72)
    expect(salienceWeight(hit({ dims: { safety: 0.8 } }), { safety: 0.9 })).toBeCloseTo(0.72, 6)
  })
  it("a drive absent from the profile → unscored → NEUTRAL_SALIENCE", () => {
    expect(salienceWeight(hit({ dims: { mystery: 0.9 } }), { safety: 0.5 })).toBe(NEUTRAL_SALIENCE)
  })
  it("multi-drive dims sum caring×intensity, clamped to [0,1]", () => {
    // 1×1 + 0×1 = 1.0
    expect(salienceWeight(hit({ dims: { safety: 1, agency: 0 } }), { safety: 1, agency: 1 })).toBeCloseTo(1, 6)
    // 0.5×0.4 + 0.5×0.4 = 0.4
    expect(salienceWeight(hit({ dims: { safety: 0.5, agency: 0.5 } }), { safety: 0.4, agency: 0.4 })).toBeCloseTo(0.4, 6)
  })
})

describe("halfLife", () => {
  it("s=0 → HALF_LIFE_MIN, s=1 → HALF_LIFE_MAX", () => {
    expect(halfLife(0)).toBe(HALF_LIFE_MIN)
    expect(halfLife(1)).toBe(HALF_LIFE_MAX)
  })
  it("is monotonically increasing in s", () => {
    expect(halfLife(0)).toBeLessThan(halfLife(0.5))
    expect(halfLife(0.5)).toBeLessThan(halfLife(1))
  })
})

describe("recency", () => {
  it("is 0.5 at exactly one half-life", () => {
    expect(recency(halfLife(0.5), 0.5)).toBeCloseTo(0.5, 6)
    expect(recency(halfLife(0), 0)).toBeCloseTo(0.5, 6)
    expect(recency(halfLife(1), 1)).toBeCloseTo(0.5, 6)
  })
  it("returns 1 for fresh / future / unknown age", () => {
    expect(recency(0, 0.5)).toBe(1)
    expect(recency(-5_000, 0.5)).toBe(1)
    expect(recency(Number.NaN, 0.5)).toBe(1)
  })
})

describe("compositeScore", () => {
  it("at age 0 reduces to relevance × reputation (recency = 1)", () => {
    // grounded (1.0) × 0.4 × 1 = 0.4 ; asserted (0.45) × 0.4 × 1 = 0.18
    expect(compositeScore(hit({ provenance: "grounded", score: 0.4 }), NOW, {})).toBeCloseTo(0.4, 6)
    expect(compositeScore(hit({ provenance: "asserted", score: 0.4 }), NOW, {})).toBeCloseTo(0.18, 6)
  })
  it("guards a non-finite score to 0", () => {
    expect(compositeScore(hit({ provenance: "grounded", score: Number.NaN }), NOW, {})).toBe(0)
  })
})

describe("rerank", () => {
  it("a grounded hit outranks an asserted hit at equal relevance and age", () => {
    const grounded = hit({ id: 1, provenance: "grounded", score: 0.5 })
    const asserted = hit({ id: 2, provenance: "asserted", score: 0.5 })
    expect(rerank([asserted, grounded], 2, NOW, {}).map((h) => h.id)).toEqual([1, 2])
  })
  it("relevance still dominates a large trust gap at equal age", () => {
    const a = hit({ id: 1, provenance: "asserted", score: 0.95 }) // 0.4275
    const b = hit({ id: 2, provenance: "grounded", score: 0.3 })  // 0.30
    expect(rerank([b, a], 2, NOW, {}).map((h) => h.id)).toEqual([1, 2])
  })
  it("a salient memory outlives a trivial one at equal relevance as age grows", () => {
    const salience = { safety: 1.0 }
    const aged = new Date(NOW - 2 * 24 * 3600_000).toISOString() // 2 days old
    const salient = hit({ id: 1, provenance: "grounded", score: 0.5, ts: aged, dims: { safety: 1.0 } })
    const trivial = hit({ id: 2, provenance: "grounded", score: 0.5, ts: aged, dims: {} })
    // Fresh (age 0): equal composite → salience is decay-only, not a rank boost.
    expect(compositeScore(hit({ ...salient, ts: new Date(NOW).toISOString() }), NOW, salience))
      .toBeCloseTo(compositeScore(hit({ ...trivial, ts: new Date(NOW).toISOString() }), NOW, salience), 6)
    // Aged: the salient memory decays slower → ranks first.
    expect(rerank([trivial, salient], 2, NOW, salience).map((h) => h.id)).toEqual([1, 2])
  })
  it("truncates to k", () => {
    expect(rerank([hit({ id: 1 }), hit({ id: 2 }), hit({ id: 3 })], 2, NOW, {})).toHaveLength(2)
  })
  it("over-fetch factor is a positive integer > 1", () => {
    expect(Number.isInteger(RERANK_OVERFETCH)).toBe(true)
    expect(RERANK_OVERFETCH).toBeGreaterThan(1)
  })
})
