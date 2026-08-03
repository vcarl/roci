import { describe, it, expect } from "vitest"
import { cosine, glossTextsFor, mechanicalVector, mergeBaseVector } from "./axis-score.js"
import { buildAxisSpecs } from "./axis-vocab.js"

const DRIVES = "- safety — your physical integrity\n- voyage — progress toward your destination"
const PALETTE = "😫 😮‍💨 😐 🤩 🚀 # burdened → exhilarated"
const SPECS = buildAxisSpecs(DRIVES, PALETTE)

describe("cosine", () => {
  it("is 1 for identical vectors and 0 for orthogonal ones", () => {
    expect(cosine([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 9)
    expect(cosine([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 9)
  })

  it("is -1 for opposed vectors and scale-invariant", () => {
    expect(cosine([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1, 9)
    expect(cosine([1, 2, 3], [10, 20, 30])).toBeCloseTo(1, 9)
  })

  it("returns 0 rather than NaN for a zero vector", () => {
    expect(cosine([0, 0, 0], [1, 2, 3])).toBe(0)
    expect(cosine([1, 2, 3], [0, 0, 0])).toBe(0)
    expect(cosine([], [])).toBe(0)
  })

  // This case previously pinned "compare over the shorter length", which turned a
  // STRUCTURAL mismatch — two vectors from different embedding spaces — into a
  // plausible finite score. That is what would make a same-dimension embedder swap
  // silently wrong instead of loudly broken. Inert (0) is the disciplined failure
  // mode here, matching the zero-norm fall-through above.
  it("returns 0 on a dimension mismatch rather than scoring over the shorter length", () => {
    expect(cosine([1, 0], [1, 0, 99])).toBe(0)
    expect(cosine([1, 0, 99], [1, 0])).toBe(0)
    // ...even when the shared prefix is perfectly aligned, which is exactly the
    // case that used to return a confident 1.
    expect(cosine([1, 2, 3], [1, 2, 3, 4])).toBe(0)
  })
})

describe("glossTextsFor", () => {
  it("emits one text per unipolar axis and TWO per bipolar axis", () => {
    expect(glossTextsFor(SPECS)).toEqual([
      { key: "safety:+", text: "safety: your physical integrity" },
      { key: "voyage:+", text: "voyage: progress toward your destination" },
      { key: "burdened-exhilarated:+", text: "exhilarated" },
      { key: "burdened-exhilarated:-", text: "burdened" },
    ])
  })

  it("emits nothing for an empty axis list", () => {
    expect(glossTextsFor([])).toEqual([])
  })
})

describe("mechanicalVector", () => {
  // A 3-dim toy space: e0 = "safety", e1 = "voyage", e2 = "exhilarated".
  const gloss = {
    "safety:+": [1, 0, 0],
    "voyage:+": [0, 1, 0],
    "burdened-exhilarated:+": [0, 0, 1],
    "burdened-exhilarated:-": [0, 0, -1],
  }

  it("scores a unipolar drive axis as the plain cosine, clamped to [0,1]", () => {
    expect(mechanicalVector([1, 0, 0], SPECS, gloss).safety).toBeCloseTo(1, 6)
    // anti-aligned with a DRIVE means 'does not bear on it', not 'negatively so'
    expect(mechanicalVector([-1, 0, 0], SPECS, gloss).safety).toBe(0)
  })

  it("scores a bipolar palette axis as positive-pole MINUS negative-pole, signed", () => {
    const towardPositive = mechanicalVector([0, 0, 1], SPECS, gloss)
    expect(towardPositive["burdened-exhilarated"]).toBeCloseTo(1, 6)
    const towardNegative = mechanicalVector([0, 0, -1], SPECS, gloss)
    expect(towardNegative["burdened-exhilarated"]).toBeCloseTo(-1, 6)
  })

  it("clamps a bipolar score to [-1,+1]", () => {
    const wild = { ...gloss, "burdened-exhilarated:-": [0, 0, -1] }
    const v = mechanicalVector([0, 0, 2], SPECS, wild)
    expect(v["burdened-exhilarated"]).toBeLessThanOrEqual(1)
    expect(v["burdened-exhilarated"]).toBeGreaterThanOrEqual(-1)
  })

  it("SKIPS an axis whose gloss vector is missing rather than scoring it 0", () => {
    const partial = { "safety:+": [1, 0, 0] }
    const v = mechanicalVector([1, 0, 0], SPECS, partial)
    expect(Object.keys(v)).toEqual(["safety"])
  })

  it("returns {} for an empty axis list or an empty memory vector", () => {
    expect(mechanicalVector([1, 0, 0], [], gloss)).toEqual({})
    expect(mechanicalVector([], SPECS, gloss)).toEqual({})
  })
})

describe("mergeBaseVector", () => {
  it("takes the per-axis MEAN where both producers scored", () => {
    expect(mergeBaseVector({ safety: 0.4 }, { safety: 0.8 })).toEqual({ safety: 0.6000000000000001 })
  })

  it("takes A alone where C did not score that axis", () => {
    expect(mergeBaseVector({ safety: 0.4, voyage: 0.2 }, { safety: 0.8 })).toEqual({
      safety: 0.6000000000000001,
      voyage: 0.2,
    })
  })

  it("takes C alone where A did not score that axis — the UNION, not the intersection", () => {
    // Deliberate: if the CLI cannot read PALETTE.md its axis list is empty and A
    // is {}. Intersecting there would DELETE a vector the host just computed —
    // inert, clean and unnoticed, the failure class of design §11.
    expect(mergeBaseVector({}, { voyage: 0.6, safety: 0.2 })).toEqual({ voyage: 0.6, safety: 0.2 })
  })

  it("is A alone when there is no C at all (pathways 5 and 6)", () => {
    expect(mergeBaseVector({ safety: 0.4 }, null)).toEqual({ safety: 0.4 })
    expect(mergeBaseVector({ safety: 0.4 }, undefined)).toEqual({ safety: 0.4 })
    expect(mergeBaseVector({ safety: 0.4 }, {})).toEqual({ safety: 0.4 })
  })

  it("averages a SIGNED bipolar pair correctly", () => {
    expect(mergeBaseVector({ "cynical-curious": -0.8 }, { "cynical-curious": 0.2 })).toEqual({
      "cynical-curious": -0.30000000000000004,
    })
  })

  it("drops a non-finite component from either side rather than propagating NaN", () => {
    expect(mergeBaseVector({ safety: Number.NaN, voyage: 0.5 }, { safety: 0.8 })).toEqual({
      safety: 0.8,
      voyage: 0.5,
    })
    expect(mergeBaseVector({ safety: 0.4 }, { safety: Number.POSITIVE_INFINITY })).toEqual({ safety: 0.4 })
  })

  it("is {} when neither producer scored anything", () => {
    expect(mergeBaseVector({}, {})).toEqual({})
  })

  it("does not let a '__proto__' key from an agent-authored C vector vanish silently", () => {
    // `--dims-c` is model-authored and reaches this function through JSON.parse,
    // which DOES create a real own property named __proto__. Assigning that onto a
    // plain object hits Object.prototype's setter instead: the number is ignored,
    // the key disappears from the stored JSON, and the row silently disagrees with
    // what the producer sent. A null-prototype accumulator keeps it honest.
    const c = JSON.parse('{"__proto__":0.5,"safety":0.4}') as Record<string, number>
    expect(JSON.stringify(mergeBaseVector({}, c))).toBe('{"__proto__":0.5,"safety":0.4}')
  })
})
