import { describe, it, expect } from "vitest"
import {
  freshCortexState,
  shouldForceOrient,
  formatStepTask,
  planSteps,
} from "./state.js"
import type { DecideResult } from "../skills/types.js"

describe("freshCortexState", () => {
  it("starts empty", () => {
    const s = freshCortexState()
    expect(s.accumulatedEvents).toEqual([])
    expect(s.currentPlan).toBeNull()
    expect(s.lastOrientTick).toBe(0)
  })
})

describe("shouldForceOrient", () => {
  const s = { ...freshCortexState(), accumulatedEvents: ["e"], lastOrientTick: 0 }
  it("forces orient once the interval elapses with pending events", () => {
    expect(shouldForceOrient(s, 5, 5)).toBe(true)
    expect(shouldForceOrient(s, 4, 5)).toBe(false)
  })
  it("never forces when no events accumulated", () => {
    expect(shouldForceOrient(freshCortexState(), 99, 5)).toBe(false)
  })
})

describe("formatStepTask", () => {
  it("includes goal and success condition", () => {
    const task = formatStepTask(
      { task: "review", goal: "review PR #12", tier: "smart", successCondition: "approved or changes requested", timeoutTicks: 4 },
      "PR #12 awaits review",
    )
    expect(task).toContain("review PR #12")
    expect(task).toContain("approved or changes requested")
  })
})

describe("planSteps", () => {
  it("returns steps for a plan decision and [] otherwise", () => {
    const plan: DecideResult = { decision: "plan", reasoning: "go", steps: [{ task: "t", goal: "g", tier: "fast", successCondition: "c", timeoutTicks: 2 }] }
    expect(planSteps(plan)).toHaveLength(1)
    expect(planSteps({ decision: "continue", reasoning: "x" })).toEqual([])
    expect(planSteps(null)).toEqual([])
  })
})
