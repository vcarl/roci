import { describe, it, expect } from "vitest"
import {
  TEMPLATE_SALIENCE,
  renderSalienceLines,
  salienceFile,
  parseSalience,
  parseVolatility,
  DEFAULT_VOLATILITY,
  VOLATILITY_MIN,
  buildAxisList,
  unknownSalienceAxes,
  AxisCollisionError,
  UnknownAxisError,
} from "./salience.js"

// The canonical §2 example (design 2026-07-21): core spine + domain drive + 1 extra.
const EXAMPLE = `- safety: 0.9        # she flinches at every threat; danger dominates her attention
- sustenance: 0.4    # resource pressure barely registers until it's dire
- agency: 0.7        # being blocked or controlled cuts deep
- voyage: 0.3        # the mission is a means, not a hunger
- reputation: 0.8    # (extra) how others see her is load-bearing to her identity`

const CORE = ["safety", "sustenance", "agency"]

describe("parseSalience", () => {
  it("maps each well-formed line to its clamped score", () => {
    expect(parseSalience(EXAMPLE)).toEqual({
      safety: 0.9, sustenance: 0.4, agency: 0.7, voyage: 0.3, reputation: 0.8,
    })
  })

  it("clamps scores to [0,1]", () => {
    const md = "- safety: 1.5  # over\n- agency: -0.2  # under\n- sustenance: 0  # floor"
    expect(parseSalience(md)).toEqual({ safety: 1, agency: 0, sustenance: 0 })
  })

  it("drops malformed / non-dimension lines", () => {
    const md = [
      "# Salience",                        // header — dropped
      "not a salience line at all",        // prose — dropped
      "- safety 0.5  # missing colon",     // no colon — dropped
      "- broken: notanumber  # NaN score", // non-numeric — dropped
      "- agency: 0.6  # kept",             // valid — kept
    ].join("\n")
    expect(parseSalience(md)).toEqual({ agency: 0.6 })
  })

  it("the §2 example's off-vocabulary key is now a defect, not an allowed extra", () => {
    const parsed = parseSalience(EXAMPLE)
    for (const d of CORE) expect(parsed).toHaveProperty(d)
    expect(parsed).toHaveProperty("voyage") // domain drive
    // `reputation` was a legal "extra" under the 2026-07-21 design. Under the
    // 2026-07-31 axis design the vocabulary is derived, so it is off-vocabulary.
    const axes = ["safety", "sustenance", "agency", "voyage"]
    expect(unknownSalienceAxes(parsed, axes)).toEqual(["reputation"])
  })
})

describe("TEMPLATE_SALIENCE", () => {
  it("parses cleanly to the core spine at neutral 0.5, no extras", () => {
    expect(parseSalience(TEMPLATE_SALIENCE)).toEqual({
      safety: 0.5, sustenance: 0.5, agency: 0.5,
    })
  })
})

describe("renderSalienceLines", () => {
  it("returns the core-only template when there are no domain drives", () => {
    expect(renderSalienceLines()).toBe(TEMPLATE_SALIENCE)
    expect(renderSalienceLines([])).toBe(TEMPLATE_SALIENCE)
  })

  it("appends a neutral 0.5 row per domain drive, parseable alongside the core spine", () => {
    const out = renderSalienceLines([{ name: "voyage", description: "reach the next system" }])
    expect(out).toContain("- voyage: 0.5")
    expect(parseSalience(out)).toEqual({
      safety: 0.5, sustenance: 0.5, agency: 0.5, voyage: 0.5,
    })
  })
})

describe("salienceFile", () => {
  it("wraps a body under the # Salience header and stays parseable", () => {
    const out = salienceFile(TEMPLATE_SALIENCE)
    expect(out.startsWith("# Salience")).toBe(true)
    expect(out.toLowerCase()).toContain("0.0")
    // The header/comment lines must not leak into the parse.
    expect(parseSalience(out)).toEqual({ safety: 0.5, sustenance: 0.5, agency: 0.5 })
  })
})

describe("parseVolatility", () => {
  it("reads a dash-less Volatility line", () => {
    expect(parseVolatility("Volatility: 0.7\n\n- safety: 0.5")).toBeCloseTo(0.7, 6)
  })

  it("is case-insensitive and tolerates leading whitespace", () => {
    expect(parseVolatility("  volatility:0.6")).toBeCloseTo(0.6, 6)
  })

  it("falls back to the 0.3 default when the line is absent", () => {
    expect(parseVolatility("- safety: 0.9\n- agency: 0.4")).toBe(DEFAULT_VOLATILITY)
    expect(DEFAULT_VOLATILITY).toBe(0.3)
  })

  it("falls back to the default on a non-numeric value", () => {
    expect(parseVolatility("Volatility: quickly")).toBe(DEFAULT_VOLATILITY)
  })

  it("clamps to (0,1] — a zero alpha would freeze the state vector forever", () => {
    expect(parseVolatility("Volatility: 0")).toBe(VOLATILITY_MIN)
    expect(parseVolatility("Volatility: -0.5")).toBe(VOLATILITY_MIN)
    expect(parseVolatility("Volatility: 2.5")).toBe(1)
    expect(VOLATILITY_MIN).toBeGreaterThan(0)
  })

  it("IGNORES a DASHED volatility line — that is a phantom axis, not the scalar", () => {
    // parseSalience matches it (it has a leading dash), parseVolatility does not.
    expect(parseVolatility("- Volatility: 0.9")).toBe(DEFAULT_VOLATILITY)
    expect(parseSalience("- Volatility: 0.9")).toEqual({ volatility: 0.9 })
  })

  it("reads the body's line, not anything in the salienceFile header comment", () => {
    const file = salienceFile("Volatility: 0.8\n\n- safety: 0.5  # gloss")
    expect(parseVolatility(file)).toBeCloseTo(0.8, 6)
    expect(parseSalience(file)).toEqual({ safety: 0.5 })
  })
})

describe("TEMPLATE_SALIENCE — volatility default", () => {
  it("carries a dash-less Volatility: 0.3 scaffold default", () => {
    expect(TEMPLATE_SALIENCE).toContain("Volatility: 0.3")
    expect(TEMPLATE_SALIENCE).not.toContain("- Volatility")
    expect(parseVolatility(TEMPLATE_SALIENCE)).toBe(0.3)
  })

  it("still parses to exactly the core spine — volatility is NOT an axis", () => {
    expect(parseSalience(TEMPLATE_SALIENCE)).toEqual({
      safety: 0.5, sustenance: 0.5, agency: 0.5,
    })
  })

  it("renderSalienceLines keeps the volatility line and appends domain rows", () => {
    const out = renderSalienceLines([{ name: "voyage", description: "reach the next system" }])
    expect(parseVolatility(out)).toBe(0.3)
    expect(parseSalience(out)).toEqual({
      safety: 0.5, sustenance: 0.5, agency: 0.5, voyage: 0.5,
    })
  })
})

describe("salienceFile header", () => {
  it("says the axis list is derived, not open-ended", () => {
    const out = salienceFile(TEMPLATE_SALIENCE)
    expect(out.toLowerCase()).toContain("derived")
    expect(out.toLowerCase()).not.toContain("character-specific")
  })

  it("states BOTH jobs — decay and situational surfacing", () => {
    const out = salienceFile(TEMPLATE_SALIENCE).toLowerCase()
    expect(out).toContain("decay")
    expect(out).toContain("surface")
  })

  it("documents the volatility line and its dash-less form", () => {
    const out = salienceFile(TEMPLATE_SALIENCE).toLowerCase()
    expect(out).toContain("volatility")
    expect(out).toContain("no leading dash")
  })
})

// Copied verbatim from players/vcarl/me/PALETTE.md.
const LIVE_PALETTE_BODY = `🙄 😒 😐 😌 🫂 # grumbling → tender
🛠️ 📏 😶 🌌 ✨ # precise → adrift
😫 😮‍💨 😐 🤩 🚀 # burdened → exhilarated
🤨 😑 😶 🧐 🔭 # cynical → curious
⚙️ 📋 😐 🌀 🗺️ # meticulous → wandering`

const DRIVE_BODY = `- safety — your physical integrity
- sustenance — the resources you need to keep operating
- agency — your freedom and ability to act
- voyage — progress toward your destination`

// The exhaustive ordering / collision cases now live with the implementation, in
// packages/player-tools/src/salience/axis-vocab.test.ts. What remains is the
// re-export's own contract.
describe("salience.ts re-exports the shared axis namespace", () => {
  it("re-exports buildAxisList with its ordering and its loud collision", () => {
    const drives = "- safety — s\n- voyage — v"
    const palette = "🙄 😒 😐 😌 🫂 # grumbling → tender"
    expect(buildAxisList(drives, palette)).toEqual(["safety", "voyage", "grumbling-tender"])
    expect(() => buildAxisList(`${drives}\n- grumbling-tender — shadow`, palette)).toThrow(
      AxisCollisionError,
    )
  })
})

describe("unknownSalienceAxes", () => {
  const axes = buildAxisList(DRIVE_BODY, LIVE_PALETTE_BODY)

  it("returns [] when every profile key is in the derived list", () => {
    const profile = parseSalience("- safety: 0.9\n- cynical-curious: 0.4\n- voyage: 0.8")
    expect(unknownSalienceAxes(profile, axes)).toEqual([])
  })

  it("does NOT report missing axes — the drive-only template fallback stays valid", () => {
    expect(unknownSalienceAxes(parseSalience(TEMPLATE_SALIENCE), axes)).toEqual([])
  })

  it("reports an off-vocabulary key — the retired 'extras' are now a defect", () => {
    const profile = parseSalience("- safety: 0.9\n- curiosity: 0.9\n- generosity: 0.7")
    expect(unknownSalienceAxes(profile, axes)).toEqual(["curiosity", "generosity"])
  })

  it("catches the phantom volatility axis — a Volatility line written WITH a dash", () => {
    const profile = parseSalience("- safety: 0.9\n- Volatility: 0.3")
    expect(unknownSalienceAxes(profile, axes)).toEqual(["volatility"])
  })

  it("UnknownAxisError names the offending keys and the expected vocabulary", () => {
    const err = new UnknownAxisError(["curiosity"], axes)
    expect(err.message).toContain("curiosity")
    expect(err.message).toContain("cynical-curious")
    expect(err._tag).toBe("UnknownAxisError")
  })
})
