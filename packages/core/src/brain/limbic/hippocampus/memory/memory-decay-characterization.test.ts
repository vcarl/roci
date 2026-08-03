/**
 * CHARACTERIZATION of the decay curve — `salienceWeight` → `halfLife` — across a
 * REALISTIC multi-axis vector (design 2026-07-31 §5; knobs §9).
 *
 * WHY THIS FILE EXISTS, separately from `memory-rank.test.ts`. That suite tests
 * the accumulation with ONE or TWO axes at hand-picked values, which is the right
 * shape for unit-testing the rule and the wrong shape for seeing its RANGE. Since
 * the axis redesign a real memory's `dims` spans a namespace that grew from 1 key
 * (the old one-hot drive tag) to 9 (4 unipolar drives + 5 bipolar palette axes),
 * and `salienceWeight` accumulates it as an UNNORMALIZED WEIGHTED SUM clamped to
 * [0,1]. Sum N terms instead of 1 and the clamp arrives N× sooner. Nothing in the
 * suite watched that happen.
 *
 * This file pins the actual numbers so the saturation point is an asserted
 * constant rather than a hand-derived suspicion, and so any future change to the
 * knobs, to the accumulation, or to the SIZE OF THE NAMESPACE shows up as a
 * failing assertion instead of silent behavioural drift.
 *
 * IT ASSERTS CURRENT BEHAVIOUR, NOT DESIRED BEHAVIOUR. Spec §9 binds
 * HALF_LIFE_MIN / HALF_LIFE_MAX / NEUTRAL_SALIENCE at their present values and
 * schedules retuning as separate work with this branch as its baseline. The
 * saturation this file documents is a FINDING handed to that work — if a retune
 * moves the curve, these numbers are meant to go red and be re-recorded.
 *
 * The saturation question is answerable here because it is pure deterministic
 * arithmetic: given a vector and a profile, `salienceWeight → halfLife` involves
 * no model, no embedder and no I/O. The one thing this file CANNOT answer is what
 * per-axis magnitudes a real embedding cosine actually produces — that needs a
 * live embedder and is out of scope. Read every threshold below as "the magnitude
 * at which decay stops discriminating", with "do real vectors reach it?" left
 * open.
 */

import { describe, it, expect } from "vitest"
import type { MemoryHit } from "./longterm-store.js"
import {
  salienceWeight,
  halfLife,
  HALF_LIFE_MIN,
  HALF_LIFE_MAX,
  NEUTRAL_SALIENCE,
} from "./memory-rank.js"
import { parseSalience, TEMPLATE_SALIENCE, unknownSalienceAxes } from "../../../../core/salience.js"
import { buildAxisSpecs } from "@roci/player-tools/axis-vocab"

const NOW = Date.parse("2026-08-01T00:00:00Z")

const hit = (dims: Record<string, number>): MemoryHit => ({
  id: 1, ts: new Date(NOW).toISOString(), source: "orient",
  provenance: "inferred", tags: [], text: "t", score: 0.5, dims,
})

const HOUR = 3_600_000
const DAY = 86_400_000

// ---------------------------------------------------------------------------
// PROFILE A — `players/vcarl/me/*`, VERBATIM SNAPSHOT taken 2026-08-01.
//
// Inlined rather than read from disk on purpose: `players/` is LIVE character
// data that this test must never depend on the mutability of (and must never
// write to). A snapshot that drifts from the live file is not a failure of this
// test — the point is a real, representative profile shape, not this character.
//
// The shape is what matters: vcarl's SALIENCE.md PREDATES the axis redesign. It
// weights the 4 drives, carries 2 keys that are no longer derived axes at all
// (curiosity, generosity — legacy "character-specific extras"), and weights NONE
// of the 5 palette axes. Palette components of a memory therefore contribute
// exactly nothing to vcarl's decay.
// ---------------------------------------------------------------------------

const VCARL_DRIVES = `
- safety — keep the hull tight, the crew safe, and no one trying to chew us up or throw us into a void.
- sustenance — keep the warp core humming, the power grid humming, and the rations in the hold; running dry or out of credits stops the whole journey.
- agency — stay in the driver's seat, keep the engines and navigation free from lockout or sabotage; any jam that stalls my plans is a real headache.
- voyage — push the *Eidolon* onward toward the next star, anomaly, or wonder; moving forward keeps the crew's hearts beating.
`

const VCARL_PALETTE = `
🙄 😒 😐 😌 🫂 # grumbling → tender
🛠️ 📏 😶 🌌 ✨ # precise → adrift
😫 😮‍💨 😐 🤩 🚀 # burdened → exhilarated
🤨 😑 😶 🧐 🔭 # cynical → curious
⚙️ 📋 😐 🌀 🗺️ # meticulous → wandering
`

const VCARL_SALIENCE_MD = `
- safety: 0.90  # Hull's my first line, crew's life is no joke
- sustenance: 0.85  # Warp core humming, keep the lights on
- agency: 0.95  # Can't have any lockout, I'm the one steering
- voyage: 0.80  # Always moving, stars are my compass
- curiosity: 0.90  # Dismantle, reassemble, know the universe
- generosity: 0.70  # Share a ration, trust a rookie, keep morale high
`

const SPECS = buildAxisSpecs(VCARL_DRIVES, VCARL_PALETTE)
const AXES = SPECS.map((s) => s.name)
const VCARL = parseSalience(VCARL_SALIENCE_MD)

// ---------------------------------------------------------------------------
// PROFILE B — a freshly-scaffolded character, where EVERY derived axis carries a
// weight. Built from the scaffold's own neutral default (`TEMPLATE_SALIENCE`)
// rather than a made-up number, so it tracks production if that default moves.
// Same 9 axes as vcarl; the only difference is that all 9 are weighted.
// ---------------------------------------------------------------------------

/** The scaffold's neutral per-axis weight — read out of TEMPLATE_SALIENCE, not retyped. */
const SCAFFOLD_NEUTRAL_WEIGHT = parseSalience(TEMPLATE_SALIENCE).safety
const FRESH: Record<string, number> = Object.fromEntries(
  AXES.map((a) => [a, SCAFFOLD_NEUTRAL_WEIGHT]),
)

// ---------------------------------------------------------------------------
// Derivation helpers. These compute the THRESHOLD from the profile; they never
// reimplement `salienceWeight` — every claim below is checked against the real
// imported function, and the two are cross-asserted in "the threshold formula
// agrees with the real function".
// ---------------------------------------------------------------------------

/** Σ of the profile weights that a vector over `axes` can actually reach. */
const scoredWeightSum = (axes: ReadonlyArray<string>, profile: Record<string, number>): number =>
  axes.reduce((t, a) => t + (typeof profile[a] === "number" ? profile[a] : 0), 0)

/**
 * The per-axis magnitude `m` at which a UNIFORM vector over `axes` first clamps
 * to 1. `salienceWeight` sums `|v| × w`, so a uniform `m` gives `m × Σw`, which
 * hits the clamp at `m = 1 / Σw`.
 */
const saturationMagnitude = (
  axes: ReadonlyArray<string>,
  profile: Record<string, number>,
): number => 1 / scoredWeightSum(axes, profile)

/** A memory whose every derived axis sits at magnitude `m` (bipolar axes signed −m). */
const uniformVector = (m: number): Record<string, number> =>
  Object.fromEntries(SPECS.map((s) => [s.name, s.polarity === "bipolar" ? -m : m]))

const days = (ms: number): number => ms / DAY
const fmt = (ms: number): string =>
  ms >= DAY ? `${days(ms).toFixed(2)} d` : `${(ms / HOUR).toFixed(2)} h`

/** The magnitude ladder every table below walks: well under the threshold → well over. */
const LADDER = [0.02, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.5, 0.8, 1.0]

const curve = (profile: Record<string, number>): Array<{ m: number; s: number; hl: number }> =>
  LADDER.map((m) => {
    const s = salienceWeight(hit(uniformVector(m)), profile)
    return { m, s, hl: halfLife(s) }
  })

describe("the axis namespace these numbers are about", () => {
  it("is 9 axes — 4 unipolar drives then 5 bipolar palette axes", () => {
    expect(AXES).toEqual([
      "safety", "sustenance", "agency", "voyage",
      "grumbling-tender", "precise-adrift", "burdened-exhilarated",
      "cynical-curious", "meticulous-wandering",
    ])
    expect(SPECS.filter((s) => s.polarity === "unipolar")).toHaveLength(4)
    expect(SPECS.filter((s) => s.polarity === "bipolar")).toHaveLength(5)
  })

  it("vcarl's pre-redesign profile weights 4 of those 9 and none of the palette", () => {
    const weighted = AXES.filter((a) => typeof VCARL[a] === "number")
    expect(weighted).toEqual(["safety", "sustenance", "agency", "voyage"])
    // Two keys that are no longer derived axes at all — inert, but they show the
    // profile was written against the old open-ended vocabulary.
    expect(unknownSalienceAxes(VCARL, AXES)).toEqual(["curiosity", "generosity"])
  })

  it("so a PURELY EMOTIONAL memory is unscorable under vcarl and falls back to neutral", () => {
    // Every palette axis hard toward a pole — as salient as a memory can be on the
    // palette tier — and vcarl's profile cannot see any of it. `scored === 0` →
    // NEUTRAL_SALIENCE. This is the quiet half of the finding: the redesign added
    // 5 axes that an un-migrated character contributes zero weight to.
    const paletteOnly = Object.fromEntries(
      SPECS.filter((s) => s.polarity === "bipolar").map((s) => [s.name, -1]),
    )
    expect(salienceWeight(hit(paletteOnly), VCARL)).toBe(NEUTRAL_SALIENCE)
    // And a full 9-axis vector scores IDENTICALLY to its 4-drive sub-vector.
    const drivesOnly = Object.fromEntries(
      SPECS.filter((s) => s.polarity === "unipolar").map((s) => [s.name, 0.2]),
    )
    expect(salienceWeight(hit(uniformVector(0.2)), VCARL))
      .toBeCloseTo(salienceWeight(hit(drivesOnly), VCARL), 12)
  })
})

describe("the saturation threshold — where decay stops discriminating", () => {
  it("pins the scored weight sums the thresholds are derived from", () => {
    // If a profile weight changes, THIS is the assertion that goes red first and
    // explains every other number in the file.
    expect(scoredWeightSum(AXES, VCARL)).toBeCloseTo(3.5, 12) // .90 + .85 + .95 + .80
    expect(SCAFFOLD_NEUTRAL_WEIGHT).toBe(0.5)
    expect(scoredWeightSum(AXES, FRESH)).toBeCloseTo(4.5, 12) // 9 × 0.5
  })

  it("vcarl (4 weighted axes, Σw = 3.5) saturates at m = 1/3.5 ≈ 0.2857", () => {
    const m = saturationMagnitude(AXES, VCARL)
    expect(m).toBeCloseTo(0.2857142857, 9)
    // AT the threshold the sum lands one float ULP short of 1 (0.999999999999…),
    // so the clamp is exact only just ABOVE it. Immaterial — a 1e-16 shortfall is
    // 8 significant figures below anything a scorer can resolve — but pinned so a
    // reader is not surprised by the `toBeCloseTo` here and the `toBe` below.
    expect(salienceWeight(hit(uniformVector(m)), VCARL)).toBeCloseTo(1, 12)
    expect(salienceWeight(hit(uniformVector(m * 1.001)), VCARL)).toBe(1)
    expect(halfLife(salienceWeight(hit(uniformVector(m * 1.001)), VCARL))).toBe(HALF_LIFE_MAX)
  })

  it("a fresh character (9 weighted axes, Σw = 4.5) saturates EARLIER, at m = 1/4.5 ≈ 0.2222", () => {
    const m = saturationMagnitude(AXES, FRESH)
    expect(m).toBeCloseTo(0.2222222222, 9)
    expect(salienceWeight(hit(uniformVector(m)), FRESH)).toBeCloseTo(1, 12)
    expect(salienceWeight(hit(uniformVector(m * 1.001)), FRESH)).toBe(1)
    expect(halfLife(salienceWeight(hit(uniformVector(m * 1.001)), FRESH))).toBe(HALF_LIFE_MAX)
    // Weighting the palette moves the cliff ~22% closer to zero. More axes
    // weighted = saturates sooner, which is the opposite of what "a richer
    // profile" sounds like it should do.
    expect(m).toBeLessThan(saturationMagnitude(AXES, VCARL))
  })

  it("just BELOW the threshold the curve is still live — this is not a tautology", () => {
    // 90% of the threshold magnitude → salienceWeight exactly 0.9 for BOTH
    // profiles (the threshold is defined as the point where m·Σw = 1), and a
    // half-life visibly short of the 30-day ceiling. If these two assertions ever
    // both pass under a saturated curve, the test has stopped discriminating.
    for (const profile of [VCARL, FRESH]) {
      const m = 0.9 * saturationMagnitude(AXES, profile)
      const s = salienceWeight(hit(uniformVector(m)), profile)
      expect(s).toBeCloseTo(0.9, 9)
      expect(halfLife(s)).toBeLessThan(HALF_LIFE_MAX)
      expect(days(halfLife(s))).toBeCloseTo(15.5377, 3) // 15.5 d, not 30 d
    }
  })

  it("the threshold formula agrees with the real function (no reimplementation drift)", () => {
    // Sweep 200 magnitudes and check `1/Σw` is exactly the first-clamp point, as
    // measured by the imported `salienceWeight` rather than by arithmetic here.
    for (const profile of [VCARL, FRESH]) {
      const threshold = saturationMagnitude(AXES, profile)
      for (let i = 1; i <= 200; i++) {
        const m = i / 200
        const s = salienceWeight(hit(uniformVector(m)), profile)
        if (m < threshold - 1e-12) expect(s).toBeLessThan(1)
        if (m > threshold + 1e-12) expect(s).toBe(1)
      }
    }
  })
})

describe("the half-life curve across plausible per-axis magnitudes", () => {
  // ── THE TABLE (printed by the test below; recorded here for a human reader) ──
  //
  //   m     │ vcarl (Σw=3.5)          │ fresh scaffold (Σw=4.5)
  //   ──────┼─────────────────────────┼─────────────────────────
  //   0.02  │ s=0.070   1.58 h        │ s=0.090   1.81 h
  //   0.05  │ s=0.175   3.16 h        │ s=0.225   4.39 h
  //   0.10  │ s=0.350  10.00 h        │ s=0.450  19.31 h
  //   0.15  │ s=0.525   1.32 d        │ s=0.675   3.54 d
  //   0.20  │ s=0.700   4.17 d        │ s=0.900  15.54 d
  //   0.25  │ s=0.875  13.18 d        │ s=1.000  30.00 d  ← saturated
  //   0.30  │ s=1.000  30.00 d  ←sat  │ s=1.000  30.00 d
  //   0.50  │ s=1.000  30.00 d        │ s=1.000  30.00 d
  //   0.80  │ s=1.000  30.00 d        │ s=1.000  30.00 d
  //   1.00  │ s=1.000  30.00 d        │ s=1.000  30.00 d
  //
  // Read it as: the ENTIRE dynamic range of decay lives in m ∈ (0, 0.29) for
  // vcarl and m ∈ (0, 0.23) for a fresh character. Above that every memory is
  // handed the same 30-day half-life and decay ranks nothing.

  it("prints the curve for both profiles", () => {
    const rows = LADDER.map((m, i) => {
      const v = curve(VCARL)[i]
      const f = curve(FRESH)[i]
      return `  m=${m.toFixed(2)} │ vcarl s=${v.s.toFixed(3)} ${fmt(v.hl).padStart(8)}` +
        ` │ fresh s=${f.s.toFixed(3)} ${fmt(f.hl).padStart(8)}`
    })
    console.log(
      ["", "decay characterization — uniform per-axis magnitude m over 9 axes", ...rows, ""].join("\n"),
    )
    expect(rows).toHaveLength(LADDER.length)
  })

  it("is monotonically non-decreasing and saturating for both profiles", () => {
    for (const profile of [VCARL, FRESH]) {
      const c = curve(profile)
      for (let i = 1; i < c.length; i++) expect(c[i].hl).toBeGreaterThanOrEqual(c[i - 1].hl)
      expect(c[c.length - 1].hl).toBe(HALF_LIFE_MAX)
      expect(c[0].hl).toBeGreaterThan(HALF_LIFE_MIN)
    }
  })

  it("pins vcarl's half-lives to the hour/day", () => {
    const c = curve(VCARL)
    const at = (m: number) => c.find((r) => r.m === m)!
    expect(at(0.02).hl / HOUR).toBeCloseTo(1.58494, 4)
    expect(at(0.05).hl / HOUR).toBeCloseTo(3.16252, 4)
    expect(at(0.1).hl / HOUR).toBeCloseTo(10.00153, 4)
    expect(days(at(0.15).hl)).toBeCloseTo(1.31792, 4)
    expect(days(at(0.2).hl)).toBeCloseTo(4.16794, 4)
    expect(days(at(0.25).hl)).toBeCloseTo(13.18119, 4)
    expect(at(0.3).hl).toBe(HALF_LIFE_MAX)
  })

  it("pins the fresh scaffold's half-lives to the hour/day", () => {
    const c = curve(FRESH)
    const at = (m: number) => c.find((r) => r.m === m)!
    expect(at(0.02).hl / HOUR).toBeCloseTo(1.80784, 4)
    expect(at(0.05).hl / HOUR).toBeCloseTo(4.39440, 4)
    expect(at(0.1).hl / HOUR).toBeCloseTo(19.31077, 4)
    expect(days(at(0.15).hl)).toBeCloseTo(3.53580, 4)
    expect(days(at(0.2).hl)).toBeCloseTo(15.53775, 4)
    expect(at(0.25).hl).toBe(HALF_LIFE_MAX)
  })

  it("EVERY magnitude at or above 0.3 collapses to one indistinguishable value", () => {
    // The headline. Two memories a whole order of magnitude apart in felt
    // intensity get IDENTICAL decay, under both profiles.
    for (const profile of [VCARL, FRESH]) {
      for (const m of [0.3, 0.5, 0.8, 1.0]) {
        expect(halfLife(salienceWeight(hit(uniformVector(m)), profile))).toBe(HALF_LIFE_MAX)
      }
    }
  })
})

describe("NEUTRAL_SALIENCE — the reference point for 'did this change anything'", () => {
  it("sits at 13.9 h, well inside the live part of the curve", () => {
    expect(NEUTRAL_SALIENCE).toBe(0.4)
    expect(halfLife(NEUTRAL_SALIENCE) / HOUR).toBeCloseTo(13.89738, 4)
  })

  it("is out-decayed by a uniform vector from m ≈ 0.11 (vcarl) / 0.09 (fresh) upward", () => {
    // The magnitude at which a SCORED memory starts outliving an UNSCORED one:
    // NEUTRAL_SALIENCE / Σw. Below it, scoring a memory makes it decay FASTER
    // than not scoring it at all.
    const crossover = (p: Record<string, number>) => NEUTRAL_SALIENCE / scoredWeightSum(AXES, p)
    expect(crossover(VCARL)).toBeCloseTo(0.1143, 4)
    expect(crossover(FRESH)).toBeCloseTo(0.0889, 4)
    for (const profile of [VCARL, FRESH]) {
      const x = crossover(profile)
      expect(salienceWeight(hit(uniformVector(x)), profile)).toBeCloseTo(NEUTRAL_SALIENCE, 9)
      expect(salienceWeight(hit(uniformVector(x * 0.5)), profile)).toBeLessThan(NEUTRAL_SALIENCE)
      expect(salienceWeight(hit(uniformVector(x * 1.5)), profile)).toBeGreaterThan(NEUTRAL_SALIENCE)
    }
    // The live band between "same as unscored" and "pinned at the ceiling" is
    // therefore only ~0.11 → ~0.29 wide for vcarl. Under an eighth of [0,1].
    expect(saturationMagnitude(AXES, VCARL) - crossover(VCARL)).toBeCloseTo(0.1714, 4)
    expect(saturationMagnitude(AXES, FRESH) - crossover(FRESH)).toBeCloseTo(0.1333, 4)
  })
})

describe("the pre-redesign baseline: legacy one-hot vs the 9-axis vector", () => {
  // The legacy shape was ONE drive at `intensity/5`, intensity ∈ {1..5} (see
  // memory-rank.test.ts: "safety hit at 0.8 (=4/5)"). One term in the sum, so the
  // clamp was reachable only by a profile weight of exactly 1.0.
  const legacy = (drive: string, intensity: number) => hit({ [drive]: intensity / 5 })

  it("NEVER saturated under vcarl's profile — no drive is weighted 1.0", () => {
    for (let i = 1; i <= 5; i++) {
      for (const d of ["safety", "sustenance", "agency", "voyage"]) {
        expect(salienceWeight(legacy(d, i), VCARL)).toBeLessThan(1)
      }
    }
    // The strongest legacy memory possible: agency (0.95) at intensity 5/5.
    const strongest = salienceWeight(legacy("agency", 5), VCARL)
    expect(strongest).toBeCloseTo(0.95, 9)
    expect(days(halfLife(strongest))).toBeCloseTo(21.5901, 3) // 21.6 d, short of 30
  })

  it("spread the whole intensity ladder across a real range of half-lives", () => {
    // safety (0.90) at 1/5 … 5/5 — five distinguishable decay rates, in DAYS:
    //   1/5 → 0.14   2/5 → 0.45   3/5 → 1.45   4/5 → 4.75   5/5 → 15.54
    const hls = [1, 2, 3, 4, 5].map((i) => halfLife(salienceWeight(legacy("safety", i), VCARL)))
    expect(hls.map((h) => Number(days(h).toFixed(2)))).toEqual([0.14, 0.45, 1.45, 4.75, 15.54])
    // Strictly increasing, none of them pinned.
    for (let i = 1; i < hls.length; i++) expect(hls[i]).toBeGreaterThan(hls[i - 1])
    expect(hls[hls.length - 1]).toBeLessThan(HALF_LIFE_MAX)
  })

  it("the SAME per-axis magnitude is 3.5× more salient once it is spread over 9 axes", () => {
    // A legacy one-hot at 0.4 vs a 9-axis vector at 0.4 on every axis: the first
    // is mid-curve, the second is pinned at the ceiling. This is what the
    // namespace growth did, with no knob having changed.
    expect(salienceWeight(legacy("safety", 2), VCARL)).toBeCloseTo(0.36, 9) // 0.4 × 0.90
    expect(days(halfLife(salienceWeight(legacy("safety", 2), VCARL)))).toBeCloseTo(0.44507, 4)
    expect(salienceWeight(hit(uniformVector(0.4)), VCARL)).toBe(1)
    expect(halfLife(salienceWeight(hit(uniformVector(0.4)), VCARL))).toBe(HALF_LIFE_MAX)
  })

  it("a MODEST 9-axis vector already exceeds anything the legacy shape could express", () => {
    // m = 0.25 — every axis only a quarter of the way out, an unremarkable memory.
    const strongestLegacy = salienceWeight(legacy("agency", 5), VCARL) // 0.95, the old ceiling
    // Under a FULLY-WEIGHTED profile it is already clamped, i.e. past the top of
    // the range the legacy one-hot could ever reach.
    expect(salienceWeight(hit(uniformVector(0.25)), FRESH)).toBe(1)
    expect(salienceWeight(hit(uniformVector(0.25)), FRESH)).toBeGreaterThan(strongestLegacy)
    // Under vcarl's 4-weighted profile it is 0.875 — still on the curve, but
    // level with "agency, maximum intensity" under the old shape. A quarter-
    // strength memory now scores what a maxed-out one used to.
    const modern = salienceWeight(hit(uniformVector(0.25)), VCARL)
    expect(modern).toBeCloseTo(0.875, 9)
    expect(modern).toBeLessThan(1)
    expect(strongestLegacy - modern).toBeLessThan(0.1)
  })
})
