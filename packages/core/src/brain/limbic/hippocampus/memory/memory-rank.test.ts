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
  moodMatch,
  situational,
  SITUATIONAL_WEIGHT,
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
  it("takes the MAGNITUDE of a bipolar component — a negative pole is salient, not trivial", () => {
    // burdened-exhilarated at -1 is "hard toward burdened": maximally salient on
    // that axis, not the neutral middle. The character weights it 0.8.
    const profile = { safety: 0.5, "burdened-exhilarated": 0.8 }
    expect(salienceWeight(hit({ dims: { "burdened-exhilarated": -1 } }), profile)).toBeCloseTo(0.8, 6)
    // Both poles read the same way: sign carries direction, not intensity (spec §6).
    expect(salienceWeight(hit({ dims: { "burdened-exhilarated": 1 } }), profile)).toBeCloseTo(0.8, 6)
  })

  it("a negative component can no longer cancel a positive one", () => {
    const profile = { safety: 0.5, "burdened-exhilarated": 0.8 }
    // 1×0.5 + |−1|×0.8 = 1.3 → clamped to 1. Under the signed formula this was
    // 0.5 − 0.8 = −0.3 → floored to 0.
    expect(salienceWeight(hit({ dims: { safety: 1, "burdened-exhilarated": -1 } }), profile))
      .toBeCloseTo(1, 6)
  })

  it("a strongly-felt memory never gets the half-life floor meant for a trivial one", () => {
    // The concrete failure this fixes: salienceWeight 0 → halfLife(0) → 1 hour,
    // the floor reserved for a maximally-TRIVIAL memory (memory-rank.ts:40-41).
    const profile = { "burdened-exhilarated": 0.9 }
    const s = salienceWeight(hit({ dims: { "burdened-exhilarated": -0.9 } }), profile)
    expect(s).toBeGreaterThan(0)
    expect(halfLife(s)).toBeGreaterThan(HALF_LIFE_MIN)
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

describe("moodMatch (design 2026-07-31 §5, job 2 — the SIGNED reading)", () => {
  it("is +1 for a perfectly aligned pair and -1 for a perfectly opposed one", () => {
    expect(moodMatch({ safety: 1 }, { safety: 1 })).toBeCloseTo(1, 6)
    expect(moodMatch({ "burdened-exhilarated": -1 }, { "burdened-exhilarated": 1 })).toBeCloseTo(-1, 6)
    expect(moodMatch({ "burdened-exhilarated": -0.7 }, { "burdened-exhilarated": -0.2 })).toBeCloseTo(1, 6)
  })

  it("is scale-invariant in each argument — magnitude is the OTHER job", () => {
    expect(moodMatch({ safety: 0.1 }, { safety: 1 })).toBeCloseTo(1, 6)
    expect(moodMatch({ safety: 1 }, { safety: 0.02 })).toBeCloseTo(1, 6)
  })

  it("normalizes over the whole vector, so a memory spread across axes matches less", () => {
    // dot = 1; ‖m‖ = √2; ‖s‖ = 1
    expect(moodMatch({ safety: 1, agency: 1 }, { safety: 1 })).toBeCloseTo(1 / Math.SQRT2, 6)
  })

  it("is 0 on either zero norm — an empty mood, a dimensionless memory, an absent one", () => {
    expect(moodMatch({ safety: 1 }, {})).toBe(0)
    expect(moodMatch({}, { safety: 1 })).toBe(0)
    expect(moodMatch(undefined, { safety: 1 })).toBe(0)
    expect(moodMatch({ safety: 0 }, { safety: 1 })).toBe(0)
  })

  it("is 0 when the two vectors share no axis at all", () => {
    expect(moodMatch({ safety: 1 }, { agency: 1 })).toBe(0)
  })

  it("ignores non-finite components rather than propagating NaN", () => {
    expect(moodMatch({ safety: Number.NaN, agency: 1 }, { agency: 1 })).toBeCloseTo(1, 6)
    expect(moodMatch({ agency: 1 }, { agency: Number.NaN })).toBe(0)
  })
})

describe("situational (the bounded positive factor)", () => {
  it("is 1 + w at full alignment and 1 - w at full opposition", () => {
    expect(situational(hit({ dims: { safety: 1 } }), { safety: 1 })).toBeCloseTo(1 + SITUATIONAL_WEIGHT, 6)
    expect(situational(hit({ dims: { "burdened-exhilarated": -1 } }), { "burdened-exhilarated": 1 }))
      .toBeCloseTo(1 - SITUATIONAL_WEIGHT, 6)
  })

  it("is STRICTLY POSITIVE at worst — an opposed memory is halved, never zeroed out of recall", () => {
    const worst = situational(hit({ dims: { "burdened-exhilarated": -1 } }), { "burdened-exhilarated": 1 })
    expect(worst).toBeGreaterThan(0)
    expect(worst).toBeCloseTo(0.5, 6)
  })

  it("is exactly 1 — inert — with no mood, or with a dimensionless memory", () => {
    expect(situational(hit({ dims: { safety: 1 } }), {})).toBe(1)
    expect(situational(hit({ dims: {} }), { safety: 1 })).toBe(1)
    expect(situational(hit({}), { safety: 1 })).toBe(1)
  })

  it("w is 0.5, at the one knob site", () => {
    expect(SITUATIONAL_WEIGHT).toBe(0.5)
  })
})

describe("compositeScore", () => {
  it("at age 0 reduces to relevance × reputation (recency = 1, no mood)", () => {
    // grounded (1.0) × 0.4 × 1 × 1 = 0.4 ; asserted (0.45) × 0.4 × 1 × 1 = 0.18
    expect(compositeScore(hit({ provenance: "grounded", score: 0.4 }), NOW, {}, {})).toBeCloseTo(0.4, 6)
    expect(compositeScore(hit({ provenance: "asserted", score: 0.4 }), NOW, {}, {})).toBeCloseTo(0.18, 6)
  })
  it("guards a non-finite score to 0", () => {
    expect(compositeScore(hit({ provenance: "grounded", score: Number.NaN }), NOW, {}, {})).toBe(0)
  })
  it("multiplies in the situational factor — mood CAN outrank provenance, by design", () => {
    // Design §5's worked example: a mood-ALIGNED asserted memory beats a
    // mood-OPPOSED grounded one at equal relevance and age.
    const mood = { "burdened-exhilarated": 1 }
    const alignedAsserted = hit({
      provenance: "asserted", score: 1, dims: { "burdened-exhilarated": 1 },
    })
    const opposedGrounded = hit({
      provenance: "grounded", score: 1, dims: { "burdened-exhilarated": -1 },
    })
    expect(compositeScore(alignedAsserted, NOW, {}, mood)).toBeCloseTo(0.45 * 1.5, 6)
    expect(compositeScore(opposedGrounded, NOW, {}, mood)).toBeCloseTo(1.0 * 0.5, 6)
    expect(compositeScore(alignedAsserted, NOW, {}, mood))
      .toBeGreaterThan(compositeScore(opposedGrounded, NOW, {}, mood))
  })
})

describe("rerank", () => {
  it("a grounded hit outranks an asserted hit at equal relevance and age", () => {
    const grounded = hit({ id: 1, provenance: "grounded", score: 0.5 })
    const asserted = hit({ id: 2, provenance: "asserted", score: 0.5 })
    expect(rerank([asserted, grounded], 2, NOW, {}, {}).map((h) => h.id)).toEqual([1, 2])
  })
  it("relevance still dominates a large trust gap at equal age", () => {
    const a = hit({ id: 1, provenance: "asserted", score: 0.95 }) // 0.4275
    const b = hit({ id: 2, provenance: "grounded", score: 0.3 })  // 0.30
    expect(rerank([b, a], 2, NOW, {}, {}).map((h) => h.id)).toEqual([1, 2])
  })
  it("a salient memory outlives a trivial one at equal relevance as age grows", () => {
    const salience = { safety: 1.0 }
    const aged = new Date(NOW - 2 * 24 * 3600_000).toISOString() // 2 days old
    const salient = hit({ id: 1, provenance: "grounded", score: 0.5, ts: aged, dims: { safety: 1.0 } })
    const trivial = hit({ id: 2, provenance: "grounded", score: 0.5, ts: aged, dims: {} })
    // Fresh (age 0) WITH NO MOOD: still equal. The DECAY reading of salience is
    // still age-gated — what retired is the claim that this holds
    // UNCONDITIONALLY (design 2026-07-31 §5; the invariant that used to be
    // asserted here without the `{}` mood qualifier).
    expect(compositeScore(hit({ ...salient, ts: new Date(NOW).toISOString() }), NOW, salience, {}))
      .toBeCloseTo(compositeScore(hit({ ...trivial, ts: new Date(NOW).toISOString() }), NOW, salience, {}), 6)
    // Aged: the salient memory decays slower → ranks first.
    expect(rerank([trivial, salient], 2, NOW, salience, {}).map((h) => h.id)).toEqual([1, 2])
  })
  it("RETIRES the decay-only invariant: with a mood, salience IS a fresh-memory rank effect", () => {
    const salience = { safety: 1.0 }
    const fresh = new Date(NOW).toISOString()
    const salient = hit({ id: 1, provenance: "grounded", score: 0.5, ts: fresh, dims: { safety: 1.0 } })
    const trivial = hit({ id: 2, provenance: "grounded", score: 0.5, ts: fresh, dims: {} })
    const mood = { safety: 1.0 }
    // 0.5 × 1.0 × 1 × 1.5 = 0.75   vs   0.5 × 1.0 × 1 × 1 = 0.5
    expect(compositeScore(salient, NOW, salience, mood)).toBeCloseTo(0.75, 6)
    expect(compositeScore(trivial, NOW, salience, mood)).toBeCloseTo(0.5, 6)
    expect(rerank([trivial, salient], 2, NOW, salience, mood).map((h) => h.id)).toEqual([1, 2])
  })
  it("truncates to k", () => {
    expect(rerank([hit({ id: 1 }), hit({ id: 2 }), hit({ id: 3 })], 2, NOW, {}, {})).toHaveLength(2)
  })
  it("over-fetch factor is a positive integer > 1", () => {
    expect(Number.isInteger(RERANK_OVERFETCH)).toBe(true)
    expect(RERANK_OVERFETCH).toBeGreaterThan(1)
  })
})
