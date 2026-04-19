import { describe, it, expect } from "vitest"
import { loadSkillSync, type LoadedSkill } from "./loader.js"
import * as path from "node:path"

const SKILLS_DIR = path.resolve(import.meta.dirname, ".")

describe("loadSkillSync", () => {
  it("loads a skill file and parses frontmatter", () => {
    const skill = loadSkillSync(path.join(SKILLS_DIR, "observe.md"))
    expect(skill.name).toBe("observe")
    expect(skill.description).toBeTruthy()
    expect(skill.template).toBeTruthy()
  })

  it("renders template variables", () => {
    const skill = loadSkillSync(path.join(SKILLS_DIR, "observe.md"))
    const rendered = skill.render({ cadence: "real-time", eventPayload: "test data" })
    expect(rendered).not.toContain("{{cadence}}")
    expect(rendered).toContain("real-time")
  })

  it("throws on missing file", () => {
    expect(() => loadSkillSync("/nonexistent/file.md")).toThrow()
  })
})
