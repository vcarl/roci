import { describe, it, expect } from "vitest"
import {
  freshCortexState,
  shouldForceOrient,
  formatStepTask,
  planSteps,
  decideSteps,
  discoverToPlan,
  isWellFormedDiscover,
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

// Regression: a small conscious model emits parseable `{"decision":"plan"}`
// with no `steps` (or `steps` a non-array). parseOr's fallback is the
// `continue` variant, so `steps` stays undefined → `decide.steps.length`
// throws in the loop. decideSteps must absorb this: a plan decision with
// missing/non-array steps yields [] (no actionable steps), never throws.
describe("decideSteps — shape-safe step access", () => {
  it("returns the steps of a well-formed plan decision", () => {
    const plan: DecideResult = {
      decision: "plan",
      reasoning: "go",
      steps: [{ task: "t", goal: "g", tier: "fast", successCondition: "c", timeoutTicks: 2 }],
    }
    expect(decideSteps(plan)).toHaveLength(1)
  })

  it("returns [] for a plan decision with MISSING steps (does not throw on .length)", () => {
    const malformed = { decision: "plan", reasoning: "go" } as unknown as DecideResult
    const steps = decideSteps(malformed)
    expect(steps).toEqual([])
    // The crashy access the loop does: `steps.length > 0`.
    expect(() => steps.length > 0).not.toThrow()
    expect(steps.length > 0).toBe(false)
  })

  it("returns [] for a plan decision with a NON-ARRAY steps", () => {
    const malformed = { decision: "plan", reasoning: "go", steps: "soon" } as unknown as DecideResult
    expect(decideSteps(malformed)).toEqual([])
  })

  it("returns [] for a plan decision with an EMPTY steps array", () => {
    const empty: DecideResult = { decision: "plan", reasoning: "go", steps: [] }
    expect(decideSteps(empty)).toEqual([])
  })

  it("returns [] for non-plan decisions and null", () => {
    expect(decideSteps({ decision: "continue", reasoning: "x" })).toEqual([])
    expect(decideSteps(null)).toEqual([])
  })
})

describe("planSteps — array safety (delegates to decideSteps)", () => {
  it("returns [] for a plan decision with a non-array steps (no crash)", () => {
    const malformed = { decision: "plan", reasoning: "go", steps: null } as unknown as DecideResult
    expect(planSteps(malformed)).toEqual([])
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
    confidence: "medium",
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
  it("includes section headings", () => {
    expect(formatSteerDirective(orient)).toContain("Impact:")
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

describe("discoverToPlan", () => {
  it("translates a discover decision into a single-step discover plan", () => {
    const decide = {
      decision: "discover" as const,
      reasoning: "flying blind at cold start",
      discover: {
        questions: ["what can my CLI do?", "where are the docs?"],
        tier: "fast" as const,
        timeoutTicks: 3,
      },
    }
    const plan = discoverToPlan(decide)
    const steps = planSteps(plan)
    expect(steps).toHaveLength(1)
    expect(steps[0].task).toBe("discover")
    expect(steps[0].tier).toBe("fast")
    expect(steps[0].timeoutTicks).toBe(3)
    expect(steps[0].goal).toContain("what can my CLI do?")
    expect(steps[0].goal).toContain("where are the docs?")
    expect(steps[0].successCondition.length).toBeGreaterThan(0)
  })
})

describe("isWellFormedDiscover — shape-safe discover guard", () => {
  it("returns true for a well-formed discover decision", () => {
    const decide: DecideResult = {
      decision: "discover",
      reasoning: "x",
      discover: { questions: ["q1"], tier: "fast", timeoutTicks: 2 },
    }
    expect(isWellFormedDiscover(decide)).toBe(true)
  })

  it("returns false when discover object is missing (the crash scenario)", () => {
    const malformed = { decision: "discover", reasoning: "x" } as unknown as DecideResult
    expect(isWellFormedDiscover(malformed)).toBe(false)
  })

  it("returns false when questions is not an array", () => {
    const malformed = {
      decision: "discover",
      reasoning: "x",
      discover: { questions: "soon", tier: "fast", timeoutTicks: 2 },
    } as unknown as DecideResult
    expect(isWellFormedDiscover(malformed)).toBe(false)
  })

  it("returns false when questions is an empty array", () => {
    const malformed = {
      decision: "discover",
      reasoning: "x",
      discover: { questions: [], tier: "fast", timeoutTicks: 2 },
    } as unknown as DecideResult
    expect(isWellFormedDiscover(malformed)).toBe(false)
  })

  it("returns false for non-discover decisions and null", () => {
    expect(isWellFormedDiscover({ decision: "continue", reasoning: "x" })).toBe(false)
    expect(isWellFormedDiscover(null)).toBe(false)
  })
})
