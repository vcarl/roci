import { describe, it, expect } from "vitest"
import {
  buildBackgroundPrompt,
  buildValuesPrompt,
  buildPalettePrompt,
  buildDrivesPrompt,
  buildSaliencePrompt,
  buildDiaryPrompt,
  buildSummaryPrompt,
  promptForStep,
  type IdentityContext,
} from "./prompts.js"

const base: IdentityContext = {
  characterName: "Dust",
  characterDescription: "a weathered solo asteroid prospector who distrusts factions",
  identityTemplate: { backgroundHints: "space MMO", valuesHints: "resource management" },
}

describe("prompt builders", () => {
  it("background prompt includes name, description and domain hints", () => {
    const p = buildBackgroundPrompt(base)
    expect(p).toContain("Dust")
    expect(p).toContain("weathered solo asteroid prospector")
    expect(p).toContain("space MMO")
  })

  it("values prompt threads the approved background", () => {
    const p = buildValuesPrompt({ ...base, background: "BACKGROUND-MARKER" })
    expect(p).toContain("BACKGROUND-MARKER")
    expect(p).toContain("resource management")
  })

  it("palette prompt asks for 5-emoji gradient rows and threads background+values", () => {
    const p = buildPalettePrompt({ ...base, background: "BG", values: "VAL" })
    expect(p).toContain("5 emoji")
    expect(p).toContain("→")
    expect(p).toContain("BG")
    expect(p).toContain("VAL")
  })

  it("diary prompt offers 8 example structures and threads values", () => {
    const p = buildDiaryPrompt({ ...base, background: "BG", values: "VAL" })
    expect(p).toContain("VAL")
    // 8 numbered example structures
    for (let n = 1; n <= 8; n++) expect(p).toContain(`${n}.`)
  })

  it("drives prompt threads the base drive block and demands stable names + line format", () => {
    const p = buildDrivesPrompt({ ...base, background: "BG", values: "VAL", baseDrives: "- safety — DRIVE-MARKER" })
    expect(p).toContain("DRIVE-MARKER")
    expect(p).toContain("VAL")
    expect(p.toLowerCase()).toContain("do not rename")
  })

  it("salience prompt threads drives + values + background and demands the weight line format", () => {
    const p = buildSaliencePrompt({ ...base, background: "BG", values: "VAL", baseDrives: "- safety — DRIVE-MARKER" })
    expect(p).toContain("DRIVE-MARKER") // the approved drive spine
    expect(p).toContain("VAL")
    expect(p).toContain("BG")
    expect(p).toContain("0.0")
    expect(p).toContain("1.0")
    expect(p).toContain("- <dimension>: <0.0-1.0>  # <short gloss in the character's voice>")
    expect(p.toLowerCase()).toContain("up to 2")
    expect(p.toLowerCase()).toContain("do not rename")
  })

  it("salience prompt appends operator feedback when present", () => {
    const p = buildSaliencePrompt({ ...base, background: "BG", values: "VAL", feedback: "make her jumpier" })
    expect(p).toContain("make her jumpier")
  })

  it("summary prompt asks for exactly 4 sentences from the background", () => {
    const p = buildSummaryPrompt({ ...base, background: "BG" })
    expect(p).toContain("4 sentences")
    expect(p).toContain("BG")
  })

  it("feedback note is appended when present", () => {
    const p = buildBackgroundPrompt({ ...base, feedback: "make her grimmer" })
    expect(p).toContain("make her grimmer")
  })

  it("promptForStep dispatches by step", () => {
    expect(promptForStep("background", base)).toBe(buildBackgroundPrompt(base))
    expect(promptForStep("diary", { ...base, values: "VAL" })).toContain("VAL")
    const sal = { ...base, baseDrives: "- safety — X" }
    expect(promptForStep("salience", sal)).toBe(buildSaliencePrompt(sal))
  })
})
