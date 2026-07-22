import { describe, it, expect } from "vitest"
import { TEMPLATE_SALIENCE, renderSalienceLines, salienceFile, parseSalience } from "./salience.js"

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

  it("the §2 example has all core + domain dims present and ≤2 extras", () => {
    const parsed = parseSalience(EXAMPLE)
    for (const d of CORE) expect(parsed).toHaveProperty(d)
    expect(parsed).toHaveProperty("voyage") // domain drive
    const extras = Object.keys(parsed).filter((k) => !CORE.includes(k) && k !== "voyage")
    expect(extras.length).toBeLessThanOrEqual(2)
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
