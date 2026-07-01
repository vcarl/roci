import * as path from "node:path"
import { describe, it, expect } from "vitest"
// tiers.ts does not export a `skills` binding — it builds one locally (module-scope
// const, not exported) via `loadSkillSync` imported from "../skills/loader.js"
// (see packages/core/src/cortex/tiers.ts lines 6 & 28-34). This test reuses that
// exact loader specifier + the same SKILLS_DIR resolution to load the real
// templates, so it exercises precisely what runForebrain/runConsciousDecide/
// runConsciousEvaluate render at runtime.
import { loadSkillSync } from "../skills/loader.js"

const SKILLS_DIR = path.resolve(import.meta.dirname, "../skills")
const skills = {
  orient: loadSkillSync(path.join(SKILLS_DIR, "orient.md")),
  decide: loadSkillSync(path.join(SKILLS_DIR, "decide.md")),
  evaluate: loadSkillSync(path.join(SKILLS_DIR, "evaluate.md")),
}

const RECALL = "\n\n## You recall\n- the raider returns at dusk"

describe("recalled-memory prompt slot", () => {
  it("orient template renders the recalled block", () => {
    const out = skills.orient.render({
      cadence: "real-time", cadenceGuidance: "", accumulatedEvents: "", domainState: "",
      background: "", values: "", diary: "", emotionalWeight: "😐", recalledMemories: RECALL,
    })
    expect(out).toContain("## You recall")
    expect(out).toContain("the raider returns at dusk")
  })

  it("decide template renders the recalled block", () => {
    const out = skills.decide.render({
      cadence: "real-time", cadenceGuidance: "", headline: "", whatChanged: "", emotionalState: "😐",
      confidence: "high", sections: "", metrics: "{}", currentPlanState: "", availableSkills: "", recalledMemories: RECALL,
    })
    expect(out).toContain("## You recall")
  })

  it("evaluate template renders the recalled block", () => {
    const out = skills.evaluate.render({
      cadence: "real-time", cadenceGuidance: "", task: "", goal: "", successCondition: "",
      ticksBudgeted: "1", secondsBudgeted: "30", ticksConsumed: "1", secondsConsumed: "30", overrunWarning: "",
      executionReport: "", stateDiff: "", conditionCheck: "", emotionalState: "😐", remainingSteps: "None.",
      recalledMemories: RECALL,
    })
    expect(out).toContain("## You recall")
  })
})
