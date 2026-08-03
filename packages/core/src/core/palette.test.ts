import { describe, it, expect } from "vitest"
import {
  TEMPLATE_PALETTE,
  paletteFile,
  paletteAxisNames,
  MalformedAxisError,
} from "./palette.js"

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

// Copied verbatim from players/vcarl/me/PALETTE.md — the live character's palette
// body, the real data this derivation has to survive.
const LIVE_PALETTE_BODY = `🙄 😒 😐 😌 🫂 # grumbling → tender
🛠️ 📏 😶 🌌 ✨ # precise → adrift
😫 😮‍💨 😐 🤩 🚀 # burdened → exhilarated
🤨 😑 😶 🧐 🔭 # cynical → curious
⚙️ 📋 😐 🌀 🗺️ # meticulous → wandering`

// The exhaustive derivation cases now live with the implementation, in
// packages/player-tools/src/salience/axis-vocab.test.ts. What remains here is
// the SHIM's own contract: that palette.ts still re-exports that derivation, and
// that the header this module wraps bodies in stays transparent to it.
describe("palette.ts re-exports the shared axis vocabulary", () => {
  it("re-exports the same derivation the CLI uses", () => {
    expect(paletteAxisNames("🙄 😒 😐 😌 🫂 # grumbling → tender")).toEqual(["grumbling-tender"])
    expect(() => paletteAxisNames("😐 😐 😐 😐 😐 #  → tender")).toThrow(MalformedAxisError)
  })

  it("still ignores the PALETTE.md header and comment lines it wraps", () => {
    expect(paletteAxisNames(paletteFile(TEMPLATE_PALETTE))).toEqual(paletteAxisNames(TEMPLATE_PALETTE))
  })

  // The two pre-move cases that exercise `paletteFile` stay here rather than
  // travelling to axis-vocab.test.ts: the wrapper is host-only and the leaf
  // module is import-free. Everything they assert is about THIS module's header
  // being transparent to the shared derivation.
  it("ignores the PALETTE.md header and comment lines around a real body", () => {
    expect(paletteAxisNames(paletteFile(LIVE_PALETTE_BODY))).toEqual(
      paletteAxisNames(LIVE_PALETTE_BODY),
    )
  })

  it("SKIPS every line of the real PALETTE.md preamble — heading, comment block, blank", () => {
    // The exact preamble paletteFile writes, with nothing after it.
    expect(paletteAxisNames(paletteFile(""))).toEqual([])
  })
})
