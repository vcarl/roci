import { describe, it, expect } from "vitest"
import {
  freshCortexState,
  shouldForceOrient,
  formatStepTask,
  planSteps,
  STEP_DONE_MARKER,
  detectCompletion,
  formatSteerDirective,
} from "./state.js"
import type { DecideResult, OrientResult } from "../skills/types.js"

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

describe("STEP_DONE_MARKER", () => {
  it("is a non-empty string", () => {
    expect(typeof STEP_DONE_MARKER).toBe("string")
    expect(STEP_DONE_MARKER.length).toBeGreaterThan(0)
  })
})

describe("detectCompletion", () => {
  it("returns true when output contains the marker", () => {
    expect(detectCompletion(`All done! ${STEP_DONE_MARKER} Great work.`)).toBe(true)
    expect(detectCompletion(STEP_DONE_MARKER)).toBe(true)
    expect(detectCompletion(`\n${STEP_DONE_MARKER}\n`)).toBe(true)
  })
  it("returns false when output does not contain the marker", () => {
    expect(detectCompletion("Task finished.")).toBe(false)
    expect(detectCompletion("")).toBe(false)
    // Case-sensitive: lowercase version must not match
    expect(detectCompletion(STEP_DONE_MARKER.toLowerCase())).toBe(false)
  })
})

describe("formatSteerDirective", () => {
  const orient: OrientResult = {
    headline: "Login flow broken after auth refactor",
    whatChanged: "OAuth redirect URL changed",
    emotionalState: "😟",
    sections: [
      { id: "s1", heading: "Impact", body: "Users cannot log in." },
      { id: "s2", heading: "Priority", body: "Fix immediately." },
    ],
    metrics: { errors: 42 },
  }

  it("includes the headline", () => {
    expect(formatSteerDirective(orient)).toContain("Login flow broken after auth refactor")
  })
  it("includes whatChanged", () => {
    expect(formatSteerDirective(orient)).toContain("OAuth redirect URL changed")
  })
  it("includes section bodies", () => {
    const d = formatSteerDirective(orient)
    expect(d).toContain("Users cannot log in.")
    expect(d).toContain("Fix immediately.")
  })
})

describe("formatStepTask (extended with marker)", () => {
  it("mentions the STEP_DONE_MARKER in the closing instruction", () => {
    const task = formatStepTask(
      { task: "fix bug", goal: "fix #42", tier: "smart", successCondition: "tests pass", timeoutTicks: 3 },
      "fixing bugs",
    )
    expect(task).toContain(STEP_DONE_MARKER)
  })
})
