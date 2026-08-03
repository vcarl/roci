import { afterEach, describe, expect, it } from "vitest"
import type { AxisSpec } from "../../../../core/salience.js"
import { EMBED_MODEL_ENV } from "./embed-endpoint.js"
import {
  buildScoringContext,
  clearAxisVocabulary,
  publishAxisVocabulary,
} from "./scoring-context.js"

type AxisOverride = Partial<AxisSpec> & { readonly name: string }

const axes = (specs: ReadonlyArray<AxisOverride>): AxisSpec[] =>
  specs.map((o) => ({
    polarity: "bipolar" as const,
    positiveGloss: `${o.name}+`,
    negativeGloss: `${o.name}-`,
    ...o,
  }))

const BASE = axes([{ name: "safety" }, { name: "grumbling-tender" }])

afterEach(() => {
  clearAxisVocabulary()
  delete process.env[EMBED_MODEL_ENV]
})

describe("the axis vocabulary stamp actually tracks the vocabulary", () => {
  it("is stable across re-publication of an identical list", () => {
    publishAxisVocabulary("ada", BASE)
    const a = buildScoringContext("ada")
    publishAxisVocabulary("ada", axes([{ name: "safety" }, { name: "grumbling-tender" }]))
    const b = buildScoringContext("ada")
    expect(b.axisVocabHash).toBe(a.axisVocabHash)
    expect(b.axisGlossHash).toBe(a.axisGlossHash)
    expect(b.axisFingerprintHash).toBe(a.axisFingerprintHash)
  })

  it("changes when an axis is added, renamed, REORDERED, or changes polarity", () => {
    publishAxisVocabulary("ada", BASE)
    const base = buildScoringContext("ada").axisVocabHash

    const variants: Array<[string, AxisSpec[]]> = [
      ["added", axes([{ name: "safety" }, { name: "grumbling-tender" }, { name: "agency" }])],
      ["renamed", axes([{ name: "safety" }, { name: "grumbling-warm" }])],
      // Order is load-bearing: the axis list is a flat ORDERED namespace.
      ["reordered", axes([{ name: "grumbling-tender" }, { name: "safety" }])],
      [
        "polarity",
        axes([{ name: "safety", polarity: "unipolar" }, { name: "grumbling-tender" }]),
      ],
    ]
    for (const [label, v] of variants) {
      publishAxisVocabulary("ada", v)
      expect(buildScoringContext("ada").axisVocabHash, label).not.toBe(base)
    }
  })

  it("separates a REWORDED gloss from a changed vocabulary — the gloss hash moves, the vocab hash does not", () => {
    publishAxisVocabulary("ada", BASE)
    const before = buildScoringContext("ada")
    publishAxisVocabulary(
      "ada",
      axes([
        { name: "safety", positiveGloss: "safety: an entirely new description" },
        { name: "grumbling-tender" },
      ]),
    )
    const after = buildScoringContext("ada")
    expect(after.axisVocabHash).toBe(before.axisVocabHash)
    expect(after.axisGlossHash).not.toBe(before.axisGlossHash)
    // The CLI's gloss-vector cache key covers both, so it must move too.
    expect(after.axisFingerprintHash).not.toBe(before.axisFingerprintHash)
  })

  it("records an ABSENCE rather than a value when nothing published (incl. a degraded empty list)", () => {
    expect(buildScoringContext("nobody")).toMatchObject({
      axisVocabHash: null,
      axisGlossHash: null,
      axisFingerprintHash: null,
      axisCount: null,
      axisNames: null,
      axisSource: "unpublished",
      glossAvailability: "unavailable",
    })
    // buildRunnerConfig degrades to [] on a malformed PALETTE.md; that must not
    // masquerade as a real vocabulary that happens to be empty.
    publishAxisVocabulary("ada", [])
    expect(buildScoringContext("ada").axisSource).toBe("unpublished")
  })
})

describe("the rest of the stamp", () => {
  it("carries the live decay knobs and a constants hash, plus a version for the maths' shape", () => {
    const ctx = buildScoringContext("ada")
    expect(ctx.constants).toEqual({
      HALF_LIFE_MIN: 3_600_000,
      HALF_LIFE_MAX: 2_592_000_000,
      SITUATIONAL_WEIGHT: 0.5,
      RERANK_OVERFETCH: 4,
    })
    expect(ctx.constantsHash).toMatch(/^[0-9a-f]{16}$/)
    expect(ctx.scorerVersion).toBe("rank-v1")
  })

  it("names the embedder only when the launcher published one", () => {
    expect(buildScoringContext("ada").embedder).toMatchObject({
      model: null,
      modelSource: "unknown",
      declaredDim: 384,
    })
    process.env[EMBED_MODEL_ENV] = "mlx-community/bge-small-en-v1.5-bf16"
    expect(buildScoringContext("ada").embedder).toMatchObject({
      model: "mlx-community/bge-small-en-v1.5-bf16",
      modelSource: "launcher-env",
    })
  })
})
