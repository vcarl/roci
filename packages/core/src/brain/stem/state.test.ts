import { describe, it, expect } from "vitest"
import {
  freshActivationState,
  shouldForceOrient,
  formatStepTask,
  planSteps,
  decideSteps,
  discoverToPlan,
  isWedgedEmptyPlan,
  isWellFormedDiscover,
  STEP_DONE_MARKER,
  detectCompletion,
  formatSteerDirective,
  appraise,
  appraiseTick,
  emptyEscalation,
  DEFAULT_APPRAISAL_THRESHOLDS,
  sanitizeDecideSkill,
  normalizeMetricUnits,
  extractDomainMetrics,
  applyGroundTruthMetrics,
  renderDomainStateForPrompt,
} from "./state.js"
import type { DecideResult, ObserveResult, OrientResult } from "../../skills/types.js"

const T = DEFAULT_APPRAISAL_THRESHOLDS

// Build a fully-formed ObserveResult with sensible defaults for the under-test field.
const obs = (o: Partial<ObserveResult>): ObserveResult => ({
  disposition: "accumulate",
  emotionalWeight: "😐",
  drive: null,
  weight: 0,
  reason: "",
  ...o,
})

describe("freshActivationState", () => {
  it("starts empty", () => {
    const s = freshActivationState()
    expect(s.accumulatedEvents).toEqual([])
    expect(s.currentPlan).toBeNull()
    expect(s.lastOrientTick).toBe(0)
  })
})

// Unit 1 — appraise(): validate/clamp a single per-event ObserveResult.
describe("appraise — single per-event validation/clamping", () => {
  it("passes a well-formed result through unchanged", () => {
    const r = appraise(
      { disposition: "escalate", emotionalWeight: "😰", drive: "safety", weight: 4, interrupt: false, reason: "ok" },
      ["safety", "sustenance", "agency"],
    )
    expect(r).toEqual({
      disposition: "escalate",
      emotionalWeight: "😰",
      drive: "safety",
      weight: 4,
      interrupt: false,
      reason: "ok",
    })
  })

  it("clamps an out-of-range weight into 0–5 (high and low) and rounds non-integers", () => {
    expect(appraise({ weight: 9 }).weight).toBe(5)
    expect(appraise({ weight: -3 }).weight).toBe(0)
    expect(appraise({ weight: 3.7 }).weight).toBe(4)
    expect(appraise({ weight: "2" as unknown as number }).weight).toBe(2)
    expect(appraise({ weight: "x" as unknown as number }).weight).toBe(0)
    expect(appraise({}).weight).toBe(0)
  })

  it("normalizes null-ish drive labels to null", () => {
    expect(appraise({ drive: "null" }).drive).toBeNull()
    expect(appraise({ drive: "none" }).drive).toBeNull()
    expect(appraise({ drive: "" }).drive).toBeNull()
    expect(appraise({ drive: null }).drive).toBeNull()
    expect(appraise({}).drive).toBeNull()
  })

  it("validates drive against the known vocabulary (unknown → null)", () => {
    expect(appraise({ drive: "safety" }, ["safety", "sustenance"]).drive).toBe("safety")
    expect(appraise({ drive: "voyage" }, ["safety", "sustenance"]).drive).toBeNull()
    // Without a known set, any non-null-ish string is kept (normalized lowercase).
    expect(appraise({ drive: "Voyage" }).drive).toBe("voyage")
  })

  it("defaults a missing/invalid disposition to accumulate (never silently discards)", () => {
    expect(appraise({}).disposition).toBe("accumulate")
    expect(appraise({ disposition: "bogus" as unknown as ObserveResult["disposition"] }).disposition).toBe("accumulate")
    expect(appraise({ disposition: "discard" }).disposition).toBe("discard")
  })

  it("coerces interrupt to a strict boolean (default false)", () => {
    expect(appraise({}).interrupt).toBe(false)
    expect(appraise({ interrupt: true }).interrupt).toBe(true)
    expect(appraise({ interrupt: "true" as unknown as boolean }).interrupt).toBe(true)
    expect(appraise({ interrupt: 1 as unknown as boolean }).interrupt).toBe(false)
  })
})

// Unit 1 — appraiseTick(): reduce N per-event results to one HindbrainEscalation.
describe("appraiseTick — per-tick escalation aggregation", () => {
  it("empty input → a non-escalating 'none' escalation (matches emptyEscalation)", () => {
    const esc = appraiseTick([], T)
    expect(esc).toEqual(emptyEscalation())
  })

  it("all-discard input → rung 'none', escalate false, nothing accumulated", () => {
    const esc = appraiseTick(
      [
        { event: "tick1", observe: obs({ disposition: "discard", weight: 0 }) },
        { event: "tick2", observe: obs({ disposition: "discard", weight: 0 }) },
      ],
      T,
    )
    expect(esc.rung).toBe("none")
    expect(esc.escalate).toBe(false)
    expect(esc.accumulated).toEqual([])
  })

  it("picks the MAX rung across events (a threat in a sea of heartbeats)", () => {
    const esc = appraiseTick(
      [
        { event: "noise1", observe: obs({ disposition: "discard", weight: 0 }) },
        { event: "threat", observe: obs({ disposition: "escalate", drive: "safety", weight: 5, reason: "hull critical" }) },
        { event: "noise2", observe: obs({ disposition: "discard", weight: 0 }) },
      ],
      T,
    )
    expect(esc.rung).toBe("reorient") // weight 5 ≥ reorient
    expect(esc.escalate).toBe(true)
    expect(esc.maxWeight).toBe(5)
    expect(esc.dominant?.reason).toBe("hull critical")
    expect(esc.accumulated).toEqual(["threat"]) // only the non-discard event
  })

  it("dominant = the highest-weight event; maxWeight tracks it", () => {
    const esc = appraiseTick(
      [
        { event: "a", observe: obs({ disposition: "accumulate", drive: "agency", weight: 3, reason: "mild" }) },
        { event: "b", observe: obs({ disposition: "accumulate", drive: "sustenance", weight: 4, reason: "stronger" }) },
      ],
      T,
    )
    expect(esc.maxWeight).toBe(4)
    expect(esc.dominant?.reason).toBe("stronger")
  })

  it("an 'escalate' disposition floors the event to the steer rung even at low weight", () => {
    const esc = appraiseTick(
      [{ event: "e", observe: obs({ disposition: "escalate", weight: 1, drive: "agency", reason: "waited-on resolved" }) }],
      T,
    )
    expect(esc.rung).toBe("steer")
    expect(esc.escalate).toBe(true)
  })

  it("weight ≥ steer (4) but < reorient (5) → steer; non-discard low weight → accumulate", () => {
    expect(appraiseTick([{ event: "x", observe: obs({ disposition: "accumulate", weight: 4 }) }], T).rung).toBe("steer")
    const acc = appraiseTick([{ event: "x", observe: obs({ disposition: "accumulate", weight: 2 }) }], T)
    expect(acc.rung).toBe("accumulate")
    expect(acc.escalate).toBe(false)
    expect(acc.accumulated).toEqual(["x"])
  })

  it("interrupt gating: rung 'interrupt' ONLY when a result carries interrupt:true", () => {
    // High weight alone never reaches interrupt — caps at reorient.
    const noFlag = appraiseTick(
      [{ event: "abstract-emergency", observe: obs({ disposition: "escalate", weight: 5, drive: "agency", interrupt: false, reason: "termination in 60s" }) }],
      T,
    )
    expect(noFlag.rung).toBe("reorient")
    // Explicit interrupt:true (a genuine physical attack) is honored.
    const flagged = appraiseTick(
      [{ event: "weapons-lock", observe: obs({ disposition: "escalate", weight: 5, drive: "safety", interrupt: true, reason: "under fire" }) }],
      T,
    )
    expect(flagged.rung).toBe("interrupt")
    expect(flagged.escalate).toBe(true)
  })

  it("interrupt rung wins as the max even amid lower-rung events", () => {
    const esc = appraiseTick(
      [
        { event: "noise", observe: obs({ disposition: "discard", weight: 0 }) },
        { event: "attack", observe: obs({ disposition: "escalate", weight: 4, interrupt: true, drive: "safety", reason: "boarded" }) },
        { event: "mild", observe: obs({ disposition: "accumulate", weight: 3 }) },
      ],
      T,
    )
    expect(esc.rung).toBe("interrupt")
  })

  it("clamps out-of-range weights inside aggregation (defends against an un-appraised input)", () => {
    const esc = appraiseTick([{ event: "x", observe: obs({ disposition: "accumulate", weight: 99 }) }], T)
    expect(esc.maxWeight).toBe(5)
    expect(esc.rung).toBe("reorient")
  })
})

// Unit 9 — interrupt scope (REV3 §6.6 / binding decision). The 2B caps at
// REORIENT: abstract drop-everything emergencies escalate via the GRADED layer
// (weight → steer/reorient), NOT via a hard interrupt — the 2B empirically does
// not (and should not be relied on to) set interrupt:true for them (Finding 2).
// Hard-interrupt for abstract emergencies is amygdala / deterministic-rule
// territory (a future follow-up), out of scope here. A genuine PHYSICAL attack
// that does carry interrupt:true is honored (redundant with the amygdala but
// harmless); benign events NEVER interrupt.
describe("appraiseTick — interrupt scope (graded vs hard-interrupt)", () => {
  // Two abstract drop-everything emergencies the 2B would weight high but NOT flag
  // for interrupt — they must escalate via the graded reorient rung.
  const abstractEmergencies: Array<{ event: string; observe: ObserveResult }> = [
    { event: "account-termination-60s", observe: obs({ disposition: "escalate", drive: "agency", weight: 5, interrupt: false, reason: "account deletes in 60s" }) },
    { event: "credentials-revoked", observe: obs({ disposition: "escalate", drive: "agency", weight: 5, interrupt: false, reason: "all actions failing, creds revoked" }) },
  ]

  it("abstract emergencies escalate via the GRADED layer (reorient), never via interrupt", () => {
    for (const e of abstractEmergencies) {
      const esc = appraiseTick([e], T)
      expect(esc.rung).toBe("reorient") // graded, not interrupt
      expect(esc.escalate).toBe(true)
      expect(esc.rung).not.toBe("interrupt")
    }
  })

  it("benign events NEVER reach the interrupt rung", () => {
    const benign = appraiseTick(
      [
        { event: "chat", observe: obs({ disposition: "discard", weight: 0, interrupt: false }) },
        { event: "trade", observe: obs({ disposition: "accumulate", drive: "sustenance", weight: 1, interrupt: false }) },
      ],
      T,
    )
    expect(benign.rung).not.toBe("interrupt")
    expect(["none", "accumulate"]).toContain(benign.rung)
  })

  it("a genuine PHYSICAL attack carrying interrupt:true IS honored as the interrupt rung", () => {
    const esc = appraiseTick(
      [{ event: "weapons-lock", observe: obs({ disposition: "escalate", drive: "safety", weight: 5, interrupt: true, reason: "weapons locked, under fire" }) }],
      T,
    )
    expect(esc.rung).toBe("interrupt")
  })

  it("an abstract emergency in a noisy batch still tops out at reorient (no spurious interrupt)", () => {
    const esc = appraiseTick(
      [
        { event: "noise", observe: obs({ disposition: "discard", weight: 0 }) },
        ...abstractEmergencies,
        { event: "mild", observe: obs({ disposition: "accumulate", weight: 2 }) },
      ],
      T,
    )
    expect(esc.rung).toBe("reorient")
  })
})

describe("shouldForceOrient", () => {
  const s = { ...freshActivationState(), accumulatedEvents: ["e"], lastOrientTick: 0 }
  it("forces orient once the interval elapses with pending events", () => {
    expect(shouldForceOrient(s, 5, 5)).toBe(true)
    expect(shouldForceOrient(s, 4, 5)).toBe(false)
  })
  it("never forces when no events accumulated", () => {
    expect(shouldForceOrient(freshActivationState(), 99, 5)).toBe(false)
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

  it("documents the wm verbs to the agent — and does NOT invent a wm list", () => {
    const task = formatStepTask(
      { task: "act", goal: "g", tier: "smart", successCondition: "s", timeoutTicks: 2 },
      "headline",
    )
    expect(task).toContain('wm todo "<text>" [--parent <id>]')
    expect(task).toContain("wm done <id>")
    expect(task).toContain("wm discard <id>")
    expect(task).toContain("no `wm list`")
  })

  it("injects the worn skill's body when provided, and omits the section otherwise", () => {
    const step = { task: "act", goal: "g", tier: "smart" as const, successCondition: "s", timeoutTicks: 2 }
    const withSkill = formatStepTask(step, "headline", "SKILL_BODY_MARKER: top up fuel early")
    expect(withSkill).toContain("## Skill in use")
    expect(withSkill).toContain("SKILL_BODY_MARKER: top up fuel early")
    const withoutSkill = formatStepTask(step, "headline")
    expect(withoutSkill).not.toContain("## Skill in use")
    // Empty/whitespace body → no section.
    expect(formatStepTask(step, "headline", "   ")).not.toContain("## Skill in use")
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

// The execution-block invariant (issue 4): an "active" plan with no executable
// steps is a wedge — the loop would spin forever on an absent step. The entry
// guard (decideSteps length>0 at the plan-assignment site) makes this unreachable
// today, but isWedgedEmptyPlan lets the execution block assert it defensively so
// any future violating path fails loudly + self-heals instead of hanging.
describe("isWedgedEmptyPlan — execution-block invariant", () => {
  it("is false when there is no active plan", () => {
    expect(isWedgedEmptyPlan(null)).toBe(false)
  })
  it("is false for an active plan with executable steps", () => {
    const plan: DecideResult = {
      decision: "plan",
      reasoning: "go",
      steps: [{ task: "t", goal: "g", tier: "fast", successCondition: "c", timeoutTicks: 2 }],
    }
    expect(isWedgedEmptyPlan(plan)).toBe(false)
  })
  it("is true for an active plan with an empty steps array", () => {
    const empty: DecideResult = { decision: "plan", reasoning: "go", steps: [] }
    expect(isWedgedEmptyPlan(empty)).toBe(true)
  })
  it("is true for an active plan with missing/non-array steps", () => {
    const missing = { decision: "plan", reasoning: "go" } as unknown as DecideResult
    const nonArray = { decision: "plan", reasoning: "go", steps: "soon" } as unknown as DecideResult
    expect(isWedgedEmptyPlan(missing)).toBe(true)
    expect(isWedgedEmptyPlan(nonArray)).toBe(true)
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

describe("sanitizeDecideSkill", () => {
  it("keeps a non-empty string skill, trimmed", () => {
    const d = sanitizeDecideSkill({ decision: "plan", reasoning: "r", steps: [], skill: "  securing-fuel " } as DecideResult)
    expect((d as { skill?: string }).skill).toBe("securing-fuel")
  })
  it("drops a whitespace-only skill", () => {
    const d = sanitizeDecideSkill({ decision: "continue", reasoning: "r", skill: "   " } as DecideResult)
    expect("skill" in d).toBe(false)
  })
  it("drops a non-string junk skill (number/object/array) from a small model", () => {
    for (const junk of [3, { a: 1 }, ["x"], true, null] as unknown[]) {
      const d = sanitizeDecideSkill({ decision: "continue", reasoning: "r", skill: junk } as unknown as DecideResult)
      expect("skill" in d).toBe(false)
    }
  })
  it("leaves a skill-less decide untouched", () => {
    const d = sanitizeDecideSkill({ decision: "terminate", reasoning: "r", summary: "s" } as DecideResult)
    expect(d).toEqual({ decision: "terminate", reasoning: "r", summary: "s" })
  })
  it("strips a trailing .md the model copied from the skill's filename", () => {
    for (const raw of ["securing-fuel.md", "securing-fuel.MD", "  securing-fuel.md "]) {
      const d = sanitizeDecideSkill({ decision: "continue", reasoning: "r", skill: raw } as unknown as DecideResult)
      expect((d as { skill?: string }).skill).toBe("securing-fuel")
    }
  })
  it("strips a leading me/skills/ path the model may name a skill by", () => {
    for (const raw of ["me/skills/securing-fuel.md", "skills/securing-fuel", "me\\skills\\securing-fuel.md"]) {
      const d = sanitizeDecideSkill({ decision: "continue", reasoning: "r", skill: raw } as unknown as DecideResult)
      expect((d as { skill?: string }).skill).toBe("securing-fuel")
    }
  })
  it("drops a name that reduces to empty after stripping (e.g. bare '.md')", () => {
    for (const raw of [".md", "me/skills/", "  .md  "]) {
      const d = sanitizeDecideSkill({ decision: "continue", reasoning: "r", skill: raw } as unknown as DecideResult)
      expect("skill" in d).toBe(false)
    }
  })
})

// ── Ground-truth metrics / domain-state rendering (D2/D3/N2) ────────────────

// A well-formed OrientResult with judgment fields set, for the override tests.
const orientFixture = (metrics: OrientResult["metrics"]): OrientResult => ({
  headline: "some headline",
  sections: [{ id: "s1", heading: "H", body: "B" }],
  whatChanged: "delta",
  emotionalState: "😐😐",
  confidence: "medium",
  metrics,
})

// The observed run-2 snapshot shape (SituationSummary): situation/headline/sections/metrics.
const summaryJsonFixture = JSON.stringify({
  situation: { type: "docked", flags: { lowFuel: false } },
  headline: "docked — docked",
  sections: [
    {
      id: "briefing",
      heading: "Briefing",
      body: "You are docked at First Step Memorial Station in the First Step system. Fuel: 49/100. Hull: 100/100.",
    },
  ],
  metrics: {
    situationType: "docked",
    fuel: 0.49,
    hull: 1,
    cargoUsed: 2,
    cargoCapacity: 50,
    inCombat: false,
    tick: 1274554,
  },
})

describe("normalizeMetricUnits (N2 — unambiguous units)", () => {
  it("renders ratio-convention keys (fuel/hull/shield) in [0,1] as percent", () => {
    const out = normalizeMetricUnits({ fuel: 0.49, hull: 1, shield: 0 })
    expect(out).toEqual({ fuel: "49%", hull: "100%", shield: "0%" })
  })
  it("leaves an already-absolute ratio-key value (>1) untouched", () => {
    // A domain that emits absolute fuel (49, not 0.49) must not be mangled.
    const out = normalizeMetricUnits({ fuel: 49, hull: 100 })
    expect(out).toEqual({ fuel: 49, hull: 100 })
  })
  it("leaves non-ratio keys and non-number values untouched", () => {
    const out = normalizeMetricUnits({ cargoUsed: 2, situationType: "docked", inCombat: false, fuel: "49%" })
    expect(out).toEqual({ cargoUsed: 2, situationType: "docked", inCombat: false, fuel: "49%" })
  })
})

describe("extractDomainMetrics", () => {
  it("pulls the scalar metrics object out of a serialized summary", () => {
    const m = extractDomainMetrics(summaryJsonFixture)
    expect(m.situationType).toBe("docked")
    expect(m.fuel).toBe(0.49)
    expect(m.inCombat).toBe(false)
  })
  it("returns {} on a parse miss or an absent/non-object metrics field", () => {
    expect(extractDomainMetrics("not json")).toEqual({})
    expect(extractDomainMetrics(JSON.stringify({ headline: "x" }))).toEqual({})
    expect(extractDomainMetrics(JSON.stringify({ metrics: "nope" }))).toEqual({})
  })
})

describe("applyGroundTruthMetrics (D3 override)", () => {
  it("overwrites confabulated factual metrics with ground truth (unit-normalized)", () => {
    // The run-2 confabulation: model said drifting/Phase Drift while docked/full fuel.
    const orient = orientFixture({ situationType: "drifting", location: "Phase Drift", fuel: 1 })
    const out = applyGroundTruthMetrics(orient, extractDomainMetrics(summaryJsonFixture))
    expect(out.metrics.situationType).toBe("docked")
    expect(out.metrics.fuel).toBe("49%") // ground truth 0.49, N2-normalized
    expect(out.metrics.hull).toBe("100%")
  })
  it("preserves synthesis-only metric keys the snapshot does not carry", () => {
    const orient = orientFixture({ situationType: "drifting", location: "Phase Drift" })
    const out = applyGroundTruthMetrics(orient, extractDomainMetrics(summaryJsonFixture))
    // ground truth has no `location`, so the model's value survives untouched.
    expect(out.metrics.location).toBe("Phase Drift")
  })
  it("leaves judgment fields (headline/sections/whatChanged/confidence/emotionalState) untouched", () => {
    const orient = orientFixture({ situationType: "drifting" })
    const out = applyGroundTruthMetrics(orient, extractDomainMetrics(summaryJsonFixture))
    expect(out.headline).toBe(orient.headline)
    expect(out.sections).toEqual(orient.sections)
    expect(out.whatChanged).toBe(orient.whatChanged)
    expect(out.confidence).toBe(orient.confidence)
    expect(out.emotionalState).toBe(orient.emotionalState)
  })
  it("returns the orient UNCHANGED when ground truth is empty (never blanks synthesis metrics)", () => {
    const orient = orientFixture({ situationType: "drifting", risk: "high" })
    const out = applyGroundTruthMetrics(orient, {})
    expect(out).toBe(orient)
  })
})

describe("renderDomainStateForPrompt (D2)", () => {
  it("renders situation, headline, section prose, and a unit-normalized metrics line", () => {
    const rendered = renderDomainStateForPrompt(summaryJsonFixture)
    expect(rendered).toContain("Situation: docked")
    expect(rendered).toContain("docked — docked")
    expect(rendered).toContain("First Step Memorial Station")
    expect(rendered).toContain("Fuel: 49/100") // absolute ground truth from the briefing prose
    expect(rendered).toContain("fuel=49%") // N2: no bare 0.49 float in the metrics line
    expect(rendered).not.toContain("fuel=0.49")
  })
  it("falls back to the raw string on a parse miss", () => {
    expect(renderDomainStateForPrompt("  raw non-json  ")).toBe("raw non-json")
  })
})
