import { describe, it, expect } from "vitest"
import {
  TEMPLATE_DRIVES,
  CORE_DRIVE_NAMES,
  drivesFile,
  renderDriveLines,
  parseDriveNames,
} from "./drives.js"

describe("TEMPLATE_DRIVES (3 core drives)", () => {
  it("names the three core drives, each as a '- name — description' line", () => {
    const lines = TEMPLATE_DRIVES.trim().split("\n")
    expect(lines.length).toBe(3)
    for (const name of CORE_DRIVE_NAMES) {
      expect(TEMPLATE_DRIVES).toContain(`- ${name} —`)
    }
  })

  it("carries the anti-collapse cue that money/fuel/quota is sustenance, not safety", () => {
    expect(TEMPLATE_DRIVES.toLowerCase()).toContain("fuel")
    expect(TEMPLATE_DRIVES.toLowerCase()).toContain("rate")
  })
})

describe("CORE_DRIVE_NAMES", () => {
  it("is exactly safety/sustenance/agency", () => {
    expect(CORE_DRIVE_NAMES).toEqual(["safety", "sustenance", "agency"])
  })
})

describe("parseDriveNames", () => {
  it("extracts the core drive names from the template block", () => {
    expect(parseDriveNames(TEMPLATE_DRIVES)).toEqual(["safety", "sustenance", "agency"])
  })

  it("extracts core + domain names from a merged block", () => {
    const merged = renderDriveLines([{ name: "voyage", description: "progress toward your destination" }])
    expect(parseDriveNames(merged)).toEqual(["safety", "sustenance", "agency", "voyage"])
  })

  it("returns [] for empty / non-matching text", () => {
    expect(parseDriveNames("")).toEqual([])
    expect(parseDriveNames("no drive lines here")).toEqual([])
  })
})

describe("renderDriveLines — core + domain merge", () => {
  it("returns the core block unchanged when no domain drives are given", () => {
    expect(renderDriveLines()).toBe(TEMPLATE_DRIVES)
    expect(renderDriveLines([])).toBe(TEMPLATE_DRIVES)
  })

  it("appends each domain drive as a '- name — description' row after the core rows", () => {
    const out = renderDriveLines([
      { name: "voyage", description: "progress toward your destination / mission" },
      { name: "stewardship", description: "the health of repos you tend" },
    ])
    expect(out.startsWith(TEMPLATE_DRIVES)).toBe(true)
    expect(out).toContain("- voyage — progress toward your destination / mission")
    expect(out).toContain("- stewardship — the health of repos you tend")
    expect(parseDriveNames(out)).toEqual(["safety", "sustenance", "agency", "voyage", "stewardship"])
  })
})

describe("drivesFile", () => {
  it("wraps a body under a # Drives header", () => {
    const out = drivesFile(TEMPLATE_DRIVES)
    expect(out.startsWith("# Drives")).toBe(true)
    expect(out).toContain("- safety —")
  })
})
