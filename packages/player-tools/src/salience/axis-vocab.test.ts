import { describe, it, expect } from "vitest"
import {
  TEMPLATE_PALETTE,
  TEMPLATE_DRIVES,
  parsePaletteAxes,
  paletteAxisNames,
  parseDriveNames,
  parseDriveLines,
  buildAxisList,
  buildAxisSpecs,
  axisFingerprint,
  sanitizeSalienceVector,
  MalformedAxisError,
  AxisCollisionError,
} from "./axis-vocab.js"

// Copied verbatim from players/vcarl/me/PALETTE.md — the live character's body.
const LIVE_PALETTE_BODY = `🙄 😒 😐 😌 🫂 # grumbling → tender
🛠️ 📏 😶 🌌 ✨ # precise → adrift
😫 😮‍💨 😐 🤩 🚀 # burdened → exhilarated
🤨 😑 😶 🧐 🔭 # cynical → curious
⚙️ 📋 😐 🌀 🗺️ # meticulous → wandering`

const DRIVE_BODY = `- safety — your physical integrity
- sustenance — the resources you need to keep operating
- agency — your freedom and ability to act
- voyage — progress toward your destination`

describe("axis-vocab — the moved Phase 1 surface", () => {
  it("derives the live character's five axes, in file order", () => {
    expect(paletteAxisNames(LIVE_PALETTE_BODY)).toEqual([
      "grumbling-tender",
      "precise-adrift",
      "burdened-exhilarated",
      "cynical-curious",
      "meticulous-wandering",
    ])
  })

  it("keeps the pole pair ordered — first pole negative, second positive", () => {
    expect(parsePaletteAxes(LIVE_PALETTE_BODY)[2]).toEqual({
      negative: "burdened",
      positive: "exhilarated",
      name: "burdened-exhilarated",
    })
  })

  it("derives axes from the seed template", () => {
    expect(paletteAxisNames(TEMPLATE_PALETTE)).toEqual([
      "sinking-soaring",
      "panic-calm",
      "fury-numb",
      "stir-stillness",
      "wonder-weariness",
    ])
  })

  it("throws on a broken axis row and collides loudly on a duplicate", () => {
    expect(() => paletteAxisNames("😐 😐 😐 😐 😐 #  → tender")).toThrow(MalformedAxisError)
    const dupe = `${LIVE_PALETTE_BODY}\n😐 😐 😐 😐 😐 # cynical → curious`
    expect(() => buildAxisList(DRIVE_BODY, dupe)).toThrow(AxisCollisionError)
  })

  it("concatenates drives then palette axes, in that order", () => {
    expect(buildAxisList(DRIVE_BODY, LIVE_PALETTE_BODY)).toEqual([
      "safety", "sustenance", "agency", "voyage",
      "grumbling-tender", "precise-adrift", "burdened-exhilarated",
      "cynical-curious", "meticulous-wandering",
    ])
  })

  it("parses the real TEMPLATE_DRIVES block", () => {
    expect(parseDriveNames(TEMPLATE_DRIVES)).toEqual(["safety", "sustenance", "agency"])
  })

  // Ported from the pre-move salience.test.ts (commit 2b1ba60): a character with
  // no PALETTE.md still gets their drive tier, and an empty palette body is not
  // an error.
  it("works with an empty palette (drive tier only)", () => {
    expect(buildAxisList(DRIVE_BODY, "")).toEqual(["safety", "sustenance", "agency", "voyage"])
  })
})

/**
 * The full Phase 1 edge-case set, ported VERBATIM from the pre-move
 * packages/core/src/core/palette.test.ts (commit 2b1ba60) when the derivation
 * moved down into this package. These are the cases the phase 1 fix wave existed
 * to establish — above all that a wrong-arrow row THROWS instead of silently
 * deriving nothing. On a design whose stated failure mode is a character quietly
 * carrying fewer axes than their PALETTE.md shows, the proof that failure is loud
 * travels with the code that makes it loud.
 *
 * The two cases that exercise `paletteFile` stayed in core's palette.test.ts:
 * that wrapper is a host-only concern and this module is import-free.
 */
describe("parsePaletteAxes — the full Phase 1 edge-case set", () => {
  it("lowercases and hyphenates multi-word poles into a legal SALIENCE.md key", () => {
    const md = "😐 😐 😐 😐 😐 # Wide Eyed → Shut Down"
    expect(paletteAxisNames(md)).toEqual(["wide-eyed-shut-down"])
    // must be a legal parseSalience key: /^[A-Za-z][\w-]*$/
    expect(/^[A-Za-z][\w-]*$/.test(paletteAxisNames(md)[0])).toBe(true)
  })

  it("SKIPS lines that are not axis lines at all, without complaint", () => {
    const md = [
      "# Palette",
      "<!-- This character's emotional voice — the axes they feel along. Each row is a",
      "     5-emoji gradient from one pole to the other. -->",
      "",
      "just some prose about the character",
      "😐 😐 😐 😐 😐 # grumbling → tender",
    ].join("\n")
    expect(paletteAxisNames(md)).toEqual(["grumbling-tender"])
  })

  it("SKIPS a '#' that appears INSIDE the comment block", () => {
    // The comment block is stripped explicitly, not by luck of containing no '#':
    // a future edit to the header prose that adds one must not start throwing.
    const md = [
      "# Palette",
      "<!-- Rows look like: 🌊 💧 😶 🌤️ ☁️ # sinking → soaring, and a bare # is fine",
      "     here too — this line has one and is still not an axis line. -->",
      "",
      "🙄 😒 😐 😌 🫂 # grumbling → tender",
    ].join("\n")
    expect(paletteAxisNames(md)).toEqual(["grumbling-tender"])
  })

  it("SKIPS a single-line comment carrying a '#', and a comment after real rows", () => {
    const md = [
      "🙄 😒 😐 😌 🫂 # grumbling → tender",
      "<!-- note: # not an axis, and neither is a -> arrow in here -->",
      "🤨 😑 😶 🧐 🔭 # cynical → curious",
    ].join("\n")
    expect(paletteAxisNames(md)).toEqual(["grumbling-tender", "cynical-curious"])
  })

  it("THROWS on a gradient row whose gloss has NO arrow at all", () => {
    // Arrow-gated classification would skip this in silence and the character
    // would quietly carry fewer axes than their PALETTE.md shows.
    expect(() => paletteAxisNames("😐 😐 😐 😐 😐 # a gloss with no arrow in it")).toThrow(
      MalformedAxisError,
    )
  })

  it("THROWS on a WRONG-ARROW row rather than deriving nothing from it", () => {
    for (const gloss of [
      "😐 😐 😐 😐 😐 # grumbling -> tender",
      "😐 😐 😐 😐 😐 # grumbling — tender",
      "😐 😐 😐 😐 😐 # grumbling to tender",
      "😐 😐 😐 😐 😐 # grumbling ⟶ tender",
    ]) {
      expect(() => paletteAxisNames(gloss), gloss).toThrow(MalformedAxisError)
    }
    // …and it names the offending line, so the fix is obvious.
    expect(() => paletteAxisNames("😐 😐 😐 😐 😐 # grumbling -> tender")).toThrow(/grumbling -> tender/)
  })

  it("a wrong-arrow row poisons the whole derivation — no partial axis list", () => {
    const md = `😐 😐 😐 😐 😐 # grumbling → tender\n😐 😐 😐 😐 😐 # precise -> adrift`
    expect(() => paletteAxisNames(md)).toThrow(MalformedAxisError)
  })

  it("THROWS on an axis-shaped line whose left pole is empty", () => {
    expect(() => paletteAxisNames("😐 😐 😐 😐 😐 #  → tender")).toThrow(MalformedAxisError)
  })

  it("THROWS on an axis-shaped line whose right pole is empty", () => {
    expect(() => paletteAxisNames("😐 😐 😐 😐 😐 # grumbling →")).toThrow(MalformedAxisError)
  })

  it("THROWS on poles that normalize away to nothing, and names the offending line", () => {
    expect(() => paletteAxisNames("😐 😐 😐 😐 😐 # ... → ???")).toThrow(MalformedAxisError)
    expect(() => paletteAxisNames("😐 😐 😐 😐 😐 # ... → ???")).toThrow(/\.\.\. → \?\?\?/)
  })

  it("THROWS on a three-pole gloss — it has the shape but no single pole pair", () => {
    expect(() => paletteAxisNames("😐 😐 😐 😐 😐 # a → b → c")).toThrow(MalformedAxisError)
  })

  it("THROWS when the derived name is not a legal SALIENCE.md key", () => {
    // parseSalience keys must start with a letter: /^-\s*([A-Za-z][\w-]*)\s*:/
    expect(() => paletteAxisNames("😐 😐 😐 😐 😐 # 1st → 2nd")).toThrow(MalformedAxisError)
  })

  it("a malformed row poisons the whole derivation — no partial axis list", () => {
    const md = `😐 😐 😐 😐 😐 # grumbling → tender\n😐 😐 😐 😐 😐 #  → adrift`
    expect(() => parsePaletteAxes(md)).toThrow(MalformedAxisError)
  })

  it("tolerates trailing whitespace on a row", () => {
    expect(paletteAxisNames("😐 😐 😐 😐 😐 # cynical → curious   ")).toEqual(["cynical-curious"])
  })

  it("SKIPS prose with a mid-line '#' — a sentence is not a gradient", () => {
    const md = [
      "# Palette",
      "These rows use # to separate the gradient from its gloss.",
      "🙄 😒 😐 😌 🫂 # grumbling → tender",
    ].join("\n")
    expect(paletteAxisNames(md)).toEqual(["grumbling-tender"])
  })

  it("SKIPS an indented prose note containing a '#', even with an arrow in it", () => {
    const md = [
      "  note: read each # gloss as poleA → poleB",
      "🤨 😑 😶 🧐 🔭 # cynical → curious",
    ].join("\n")
    expect(paletteAxisNames(md)).toEqual(["cynical-curious"])
  })

  it("STILL throws on a real gradient row whose arrow is wrong — the loudness R2 must not cost", () => {
    expect(() => paletteAxisNames("🙄 😒 😐 😌 🫂 # grumbling -> tender")).toThrow(MalformedAxisError)
    expect(() => paletteAxisNames("🙄 😒 😐 😌 🫂 # grumbling — tender")).toThrow(MalformedAxisError)
  })

  it("STILL throws on a real gradient row with an empty pole", () => {
    expect(() => paletteAxisNames("🙄 😒 😐 😌 🫂 #  → tender")).toThrow(MalformedAxisError)
  })

  it("accepts a gradient row whose emoji are separated by non-letter punctuation", () => {
    expect(paletteAxisNames("🌊/💧/😶/🌤️/☁️ # sinking → soaring")).toEqual(["sinking-soaring"])
  })
})

describe("parseDriveLines", () => {
  it("recovers name AND description, in file order", () => {
    expect(parseDriveLines(DRIVE_BODY)).toEqual([
      { name: "safety", description: "your physical integrity" },
      { name: "sustenance", description: "the resources you need to keep operating" },
      { name: "agency", description: "your freedom and ability to act" },
      { name: "voyage", description: "progress toward your destination" },
    ])
  })

  it("is the superset parseDriveNames is defined in terms of", () => {
    expect(parseDriveLines(TEMPLATE_DRIVES).map((d) => d.name)).toEqual(parseDriveNames(TEMPLATE_DRIVES))
  })

  it("tolerates a description-less row", () => {
    expect(parseDriveLines("- safety —")).toEqual([{ name: "safety", description: "" }])
  })
})

describe("buildAxisSpecs", () => {
  const specs = buildAxisSpecs(DRIVE_BODY, LIVE_PALETTE_BODY)

  it("names match buildAxisList exactly, in the same order", () => {
    expect(specs.map((s) => s.name)).toEqual(buildAxisList(DRIVE_BODY, LIVE_PALETTE_BODY))
  })

  it("drives are unipolar with the description as their gloss", () => {
    expect(specs[0]).toEqual({
      name: "safety",
      polarity: "unipolar",
      positiveGloss: "safety: your physical integrity",
      negativeGloss: "",
    })
  })

  it("palette axes are bipolar with one gloss per POLE, hyphens read as spaces", () => {
    const axis = specs.find((s) => s.name === "burdened-exhilarated")
    expect(axis).toEqual({
      name: "burdened-exhilarated",
      polarity: "bipolar",
      positiveGloss: "exhilarated",
      negativeGloss: "burdened",
    })
    const multi = buildAxisSpecs("- safety — s", "😐 😐 😐 😐 😐 # Wide Eyed → Shut Down")
    expect(multi[1]).toEqual({
      name: "wide-eyed-shut-down",
      polarity: "bipolar",
      positiveGloss: "shut down",
      negativeGloss: "wide eyed",
    })
  })

  it("propagates both Phase 1 failures unchanged", () => {
    expect(() => buildAxisSpecs(DRIVE_BODY, "😐 😐 😐 😐 😐 # a → b → c")).toThrow(MalformedAxisError)
    expect(() =>
      buildAxisSpecs(`${DRIVE_BODY}\n- cynical-curious — shadow`, LIVE_PALETTE_BODY),
    ).toThrow(AxisCollisionError)
  })
})

describe("axisFingerprint", () => {
  it("is stable for the same specs and differs when a GLOSS changes", () => {
    const a = buildAxisSpecs(DRIVE_BODY, LIVE_PALETTE_BODY)
    const b = buildAxisSpecs(DRIVE_BODY, LIVE_PALETTE_BODY)
    expect(axisFingerprint(a)).toBe(axisFingerprint(b))
    const reworded = buildAxisSpecs(DRIVE_BODY.replace("your physical integrity", "your hull"), LIVE_PALETTE_BODY)
    expect(axisFingerprint(reworded)).not.toBe(axisFingerprint(a))
  })

  it("differs when an axis is added, and is empty-stable", () => {
    const base = buildAxisSpecs(DRIVE_BODY, LIVE_PALETTE_BODY)
    const more = buildAxisSpecs(DRIVE_BODY, `${LIVE_PALETTE_BODY}\n😐 😐 😐 😐 😐 # tight → loose`)
    expect(axisFingerprint(more)).not.toBe(axisFingerprint(base))
    expect(axisFingerprint([])).toBe(axisFingerprint([]))
  })
})

describe("sanitizeSalienceVector", () => {
  const specs = buildAxisSpecs(DRIVE_BODY, LIVE_PALETTE_BODY)

  it("keeps known axes and drops unknown keys", () => {
    expect(sanitizeSalienceVector({ safety: 0.8, curiosity: 0.9 }, specs)).toEqual({ safety: 0.8 })
  })

  it("clamps a unipolar drive axis to [0,1] — a negative drive score is meaningless", () => {
    expect(sanitizeSalienceVector({ safety: -0.4, voyage: 2.5 }, specs)).toEqual({ safety: 0, voyage: 1 })
  })

  it("clamps a bipolar palette axis to [-1,+1] and PRESERVES the sign", () => {
    expect(sanitizeSalienceVector({ "burdened-exhilarated": -3 }, specs)).toEqual({
      "burdened-exhilarated": -1,
    })
    expect(sanitizeSalienceVector({ "cynical-curious": -0.7 }, specs)).toEqual({
      "cynical-curious": -0.7,
    })
  })

  it("is case-insensitive on the key and coerces numeric strings", () => {
    expect(sanitizeSalienceVector({ Safety: "0.5" }, specs)).toEqual({ safety: 0.5 })
  })

  it("drops non-finite values rather than storing NaN", () => {
    expect(sanitizeSalienceVector({ safety: "x", voyage: null, agency: 0.3 }, specs)).toEqual({ agency: 0.3 })
  })

  it("returns {} for a non-object, an array, or an empty spec list", () => {
    expect(sanitizeSalienceVector(null, specs)).toEqual({})
    expect(sanitizeSalienceVector([1, 2], specs)).toEqual({})
    expect(sanitizeSalienceVector("nope", specs)).toEqual({})
    expect(sanitizeSalienceVector({ safety: 0.5 }, [])).toEqual({})
  })

  // ── The all-zero guard (task-12 review, finding 2) ───────────────────────
  //
  // A vector of nothing but zeros is a model saying "I have no reading", not a
  // measurement that every axis is neutral. Kept, it is NON-EMPTY, so
  // encodeRememberArgs ships it as --dims-c and mergeBaseVector averages it
  // against the mechanical A vector — halving A on every axis it names. That is
  // the "C must not cancel A" hazard the null-drop rule exists to prevent,
  // arriving through a literal 0.

  it("treats an ALL-ZERO vector as no reading at all, so it can never halve A", () => {
    expect(sanitizeSalienceVector({ safety: 0 }, specs)).toEqual({})
    expect(
      sanitizeSalienceVector({ safety: 0, voyage: 0, "cynical-curious": 0 }, specs),
    ).toEqual({})
  })

  it("treats a vector that CLAMPS to all-zero as no reading either", () => {
    // -0.4 on a unipolar axis clamps to 0; the result is all-zero and must go.
    expect(sanitizeSalienceVector({ safety: -0.4 }, specs)).toEqual({})
  })

  it("keeps a genuine mix of zeros and non-zeros INTACT — only all-zero is noise", () => {
    expect(sanitizeSalienceVector({ safety: 0, voyage: 0.7 }, specs)).toEqual({
      safety: 0,
      voyage: 0.7,
    })
    expect(sanitizeSalienceVector({ safety: 0, "cynical-curious": -0.6 }, specs)).toEqual({
      safety: 0,
      "cynical-curious": -0.6,
    })
  })

  it("does not confuse a negative reading with an absent one", () => {
    // -0.6 is a real measurement toward the first pole, not a missing value.
    expect(sanitizeSalienceVector({ "cynical-curious": -0.6 }, specs)).toEqual({
      "cynical-curious": -0.6,
    })
  })
})
