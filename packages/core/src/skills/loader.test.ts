import { describe, it, expect } from "vitest"
import { loadSkillSync, type LoadedSkill } from "./loader.js"
import { getCadenceGuidance } from "#brain/limbic/autonomic/cadence.js"
import * as path from "node:path"

// observe/orient are limbic-tier prompts; decide/evaluate are cortex/conscious-tier
// prompts (Task 10 split them out of the old shared skills/ dir into their owning
// layers — see brain/limbic/tiers-limbic.ts and brain/cortex/conscious/tiers-conscious.ts).
const LIMBIC_PROMPTS_DIR = path.resolve(import.meta.dirname, "../brain/limbic/prompts")
const CONSCIOUS_PROMPTS_DIR = path.resolve(import.meta.dirname, "../brain/cortex/conscious/prompts")

describe("loadSkillSync", () => {
  it("loads a skill file and parses frontmatter", () => {
    const skill = loadSkillSync(path.join(LIMBIC_PROMPTS_DIR, "observe.md"))
    expect(skill.name).toBe("observe")
    expect(skill.description).toBeTruthy()
    expect(skill.template).toBeTruthy()
  })

  it("renders template variables", () => {
    const skill = loadSkillSync(path.join(LIMBIC_PROMPTS_DIR, "observe.md"))
    const rendered = skill.render({ event: "EVENT-MARKER", drives: "d", palette: "p", waitState: "w" })
    expect(rendered).not.toContain("{{event}}")
    expect(rendered).toContain("EVENT-MARKER")
  })

  it("throws on missing file", () => {
    expect(() => loadSkillSync("/nonexistent/file.md")).toThrow()
  })

  it("loads orient.md", () => {
    const skill = loadSkillSync(path.join(LIMBIC_PROMPTS_DIR, "orient.md"))
    expect(skill.name).toBe("orient")
    expect(skill.template).toContain("situation synthesizer")
  })

  it("loads decide.md", () => {
    const skill = loadSkillSync(path.join(CONSCIOUS_PROMPTS_DIR, "decide.md"))
    expect(skill.name).toBe("decide")
    expect(skill.template).toContain("decision-maker")
  })

  it("loads evaluate.md", () => {
    const skill = loadSkillSync(path.join(CONSCIOUS_PROMPTS_DIR, "evaluate.md"))
    expect(skill.name).toBe("evaluate")
    expect(skill.template).toContain("evaluating")
  })
})

describe("getCadenceGuidance", () => {
  it("returns guidance for observe + real-time", () => {
    const guidance = getCadenceGuidance("observe", "real-time")
    expect(guidance).toContain("LOW")
  })

  it("returns guidance for decide + planned-action", () => {
    const guidance = getCadenceGuidance("decide", "planned-action")
    expect(guidance).toContain("3-5 steps")
  })

  it("returns empty string for unknown skill", () => {
    expect(getCadenceGuidance("nonexistent", "real-time")).toBe("")
  })
})
