import { describe, it, expect } from "vitest"
import { TEMPLATE_PALETTE, paletteFile } from "./palette.js"

describe("TEMPLATE_PALETTE (5-emoji gradient)", () => {
  const rows = TEMPLATE_PALETTE.trim().split("\n")

  it("has 4-6 rows", () => {
    expect(rows.length).toBeGreaterThanOrEqual(4)
    expect(rows.length).toBeLessThanOrEqual(6)
  })

  it("each row is 5 emoji then a '# poleA → poleB' gloss", () => {
    for (const row of rows) {
      const [emojiPart, gloss] = row.split("#")
      expect(gloss, `row missing gloss: ${row}`).toBeDefined()
      expect(gloss).toContain("→")
      // 5 whitespace-separated emoji tokens before the '#'
      const tokens = emojiPart.trim().split(/\s+/)
      expect(tokens.length, `row not 5 emoji: ${row}`).toBe(5)
    }
  })

  it("no longer uses the old two-pole ↔ separator", () => {
    expect(TEMPLATE_PALETTE).not.toContain("↔")
  })
})

describe("paletteFile", () => {
  it("wraps a body under the # Palette header and mentions intensity-by-repetition", () => {
    const out = paletteFile("🌊 💧 😶 🌤️ ☁️   # sinking → soaring")
    expect(out.startsWith("# Palette")).toBe(true)
    expect(out).toContain("🌊 💧 😶 🌤️ ☁️")
    expect(out.toLowerCase()).toContain("repeat")
  })
})
