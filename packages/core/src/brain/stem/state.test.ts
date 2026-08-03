import { describe, it, expect } from "vitest"
import {
  freshActivationState,
  shouldForceOrient,
  formatStepTask,
  decideSteps,
  discoverToPlan,
  isWedgedEmptyPlan,
  isWellFormedDiscover,
  STEP_DONE_MARKER,
  detectCompletion,
  formatSteerDirective,
  appraise,
  appraiseTick,
  beatsDominant,
  emptyEscalation,
  DEFAULT_APPRAISAL_THRESHOLDS,
  sanitizeDecideSkill,
  normalizeMetricUnits,
  extractDomainMetrics,
  applyGroundTruthMetrics,
  renderDomainStateForPrompt,
  eventFingerprint,
  isChatEventType,
  composeDigestedEventText,
  countRecentFingerprints,
  summarizeEventText,
  planTitleFromHeadline,
  DEDUP_WINDOW_TICKS,
  isControlPlaneEventType,
  clampControlPlaneAppraisal,
  hasCombatEvidence,
  downgradeUnsupportedThreat,
  guardAppraisal,
  scrubVolatileMetrics,
  CONTROL_PLANE_MAX_WEIGHT,
  UNSUPPORTED_THREAT_WEIGHT,
} from "./state.js"
import { buildAxisSpecs } from "../../core/salience.js"
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
  it("passes a well-formed result through unchanged (plus the model provenance stamp)", () => {
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
      source: "model",
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

  it("stamps source:'model' on EVERY appraisal it validates, including a junk one", () => {
    // `appraise` is the one gate every model-produced appraisal passes through,
    // so it is the one honest place to stamp provenance. A parse-miss fallback
    // is still the model's turn — it gets the same stamp.
    expect(appraise({}).source).toBe("model")
    expect(appraise({ disposition: "bogus" as unknown as ObserveResult["disposition"] }).source).toBe("model")
    expect(appraise({ weight: 9, drive: "safety", reason: "x" }, ["safety"]).source).toBe("model")
  })

  it("a caller-supplied source is IGNORED — provenance is decided by the producer, not the payload", () => {
    // A model cannot promote itself to ground truth by emitting `"source"`.
    expect(appraise({ source: "deterministic" } as Record<string, unknown>).source).toBe("model")
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
    expect(esc.dominantEvent).toBe("threat") // raw text of the highest-weight event (Task 4a)
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

  // ── Tie-break (spec A §5e) ────────────────────────────────────────────────
  // `loop.ts` pushes inert appraisals FIRST, duplicates second, landed model
  // appraisals LAST. Under a strictly-greater comparison every equal-weight tie
  // therefore went to a placeholder, and `dominant` is what feeds
  // `cortex.emotionalWeight` and the mood EMA's reading.

  it("at equal weight, a MODEL appraisal beats a deterministic placeholder pushed first", () => {
    const inert = obs({
      disposition: "discard",
      weight: 0,
      emotionalWeight: "😐",
      reason: "inert event — no state change (fast-path discard)",
      source: "deterministic",
    })
    const model = obs({
      disposition: "accumulate",
      weight: 0,
      emotionalWeight: "😨",
      reason: "a quiet but real observation",
    })
    const esc = appraiseTick(
      [
        { event: "inert", observe: inert },
        { event: "real", observe: model },
      ],
      T,
    )
    expect(esc.dominant?.reason).toBe("a quiet but real observation")
    expect(esc.dominantEvent).toBe("real")
    // The mood reading comes off `dominant` — this is the behavioral consequence.
    expect(esc.dominant?.emotionalWeight).toBe("😨")
  })

  it("at equal weight and equal provenance, a non-discard beats a discard pushed first", () => {
    const dropped = obs({
      disposition: "discard",
      weight: 0,
      reason: "duplicate of recent event (3x)",
      source: "deterministic",
    })
    const kept = obs({
      disposition: "accumulate",
      weight: 0,
      reason: "RULE: fuel 8%",
      source: "deterministic",
    })
    const esc = appraiseTick(
      [
        { event: "dup", observe: dropped },
        { event: "rule", observe: kept },
      ],
      T,
    )
    expect(esc.dominant?.reason).toBe("RULE: fuel 8%")
    expect(esc.dominantEvent).toBe("rule")
  })

  it("keeps first-wins stability when two MODEL appraisals tie on weight and disposition", () => {
    // Ordering among equally-ranked model appraisals is unchanged: still the
    // first entry. The fix is targeted, not a general reshuffle.
    const a = obs({ disposition: "accumulate", weight: 3, reason: "first" })
    const b = obs({ disposition: "accumulate", weight: 3, reason: "second" })
    const esc = appraiseTick(
      [
        { event: "a", observe: a },
        { event: "b", observe: b },
      ],
      T,
    )
    expect(esc.dominant?.reason).toBe("first")
  })

  it("weight still wins outright — a heavier DETERMINISTIC appraisal beats a lighter model one", () => {
    const rule = obs({ disposition: "escalate", weight: 4, reason: "RULE: hull 12%", source: "deterministic" })
    const model = obs({ disposition: "accumulate", weight: 2, reason: "chatter" })
    const esc = appraiseTick(
      [
        { event: "chat", observe: model },
        { event: "rule", observe: rule },
      ],
      T,
    )
    expect(esc.dominant?.reason).toBe("RULE: hull 12%")
    expect(esc.maxWeight).toBe(4)
  })
})

// Unit — the dominant-selection predicate itself (spec A §5e).
describe("beatsDominant — dominant-appraisal resolution order", () => {
  const model = (o: Partial<ObserveResult>) => obs({ disposition: "accumulate", weight: 1, ...o })
  const rule = (o: Partial<ObserveResult>) =>
    obs({ disposition: "accumulate", weight: 1, source: "deterministic", ...o })

  it("higher weight always wins, in both directions and regardless of provenance", () => {
    expect(beatsDominant(model({}), 1, rule({}), 4)).toBe(true)
    expect(beatsDominant(rule({}), 4, model({}), 1)).toBe(false)
  })

  it("an UNSTAMPED appraisal counts as model and is never displaced by a deterministic one at equal weight", () => {
    const unstamped = obs({ disposition: "accumulate", weight: 1, reason: "legacy" })
    expect(beatsDominant(unstamped, 1, rule({}), 1)).toBe(false)
    expect(beatsDominant(rule({}), 1, unstamped, 1)).toBe(true)
  })

  it("two deterministic appraisals at equal weight resolve on disposition, then hold", () => {
    expect(beatsDominant(rule({ disposition: "discard" }), 1, rule({ disposition: "accumulate" }), 1)).toBe(true)
    expect(beatsDominant(rule({ disposition: "accumulate" }), 1, rule({ disposition: "discard" }), 1)).toBe(false)
    expect(beatsDominant(rule({ disposition: "accumulate" }), 1, rule({ disposition: "escalate" }), 1)).toBe(false)
  })

  it("a fully tied challenger never displaces the incumbent", () => {
    expect(beatsDominant(model({}), 1, model({}), 1)).toBe(false)
    expect(beatsDominant(rule({}), 0, rule({}), 0)).toBe(false)
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

  it("returns [] for a plan decision with a NULL steps (no crash)", () => {
    const malformed = { decision: "plan", reasoning: "go", steps: null } as unknown as DecideResult
    expect(decideSteps(malformed)).toEqual([])
  })

  it("returns [] for non-plan decisions and null", () => {
    expect(decideSteps({ decision: "continue", reasoning: "x" })).toEqual([])
    expect(decideSteps(null)).toEqual([])
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
    const steps = decideSteps(plan)
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
  it("preserves synthesis metric VALUES when ground truth is empty (never blanks them)", () => {
    const orient = orientFixture({ situationType: "drifting", risk: "high" })
    const out = applyGroundTruthMetrics(orient, {})
    expect(out.metrics).toEqual({ situationType: "drifting", risk: "high" })
  })
  it("normalizes the model's OWN ratio floats even when ground truth is empty (run-3 regression: fuel=1 number → '100%')", () => {
    // The exact live case: run-3's orient synthesized `fuel:1, hull:1` bare
    // floats while the domain state carried no top-level `metrics`, so ground
    // was empty. The old early-return let those bare floats reach the
    // transition/episode records instead of a percent. Every consumer must see
    // the "100%" style — including when the ONLY metrics are the model's own.
    const orient = orientFixture({ situationType: "docked", fuel: 1, hull: 1 })
    const out = applyGroundTruthMetrics(orient, {})
    expect(out.metrics.fuel).toBe("100%")
    expect(out.metrics.hull).toBe("100%")
    expect(out.metrics.situationType).toBe("docked")
  })
  it("normalizes synthesis-only ratio keys the ground snapshot does not carry", () => {
    // ground has no `shield`; the model's bare 0.5 must still render as percent.
    const orient = orientFixture({ shield: 0.5 })
    const out = applyGroundTruthMetrics(orient, extractDomainMetrics(summaryJsonFixture))
    expect(out.metrics.shield).toBe("50%")
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

// ── Mechanical event dedup (Task 1) ──────────────────────────────────────────

// The loop's event text shape: a "type: <type>" first line + the raw JSON.
const evText = (type: string, payload: Record<string, unknown>): string =>
  `type: ${type}\n${JSON.stringify({ type, payload })}`

describe("eventFingerprint", () => {
  it("keys same-station observation_updates identically despite different transient deltas + tick", () => {
    // The run-3 flood: same station announced ~35× while nearby-player deltas
    // and the frame `tick` churn every frame. Salient scalar identity
    // (poi_id/system_id) collapses them; arrays + volatile tick are dropped.
    const a = evText("observation_update", {
      poi_id: "first_step_memorial_station",
      system_id: "first_step",
      tick: 1274554,
      system_changed: [{ player_id: "aaa" }],
      unknown_signature: false,
    })
    const b = evText("observation_update", {
      poi_id: "first_step_memorial_station",
      system_id: "first_step",
      tick: 1274999,
      system_changed: [{ player_id: "bbb" }, { player_id: "ccc" }],
      unknown_signature: false,
    })
    expect(eventFingerprint(a).full).toBe(eventFingerprint(b).full)
    expect(eventFingerprint(a).type).toBe("observation_update")
  })
  it("distinguishes a genuinely different station (changed salient payload)", () => {
    const a = evText("observation_update", { poi_id: "station_a", system_id: "s1" })
    const b = evText("observation_update", { poi_id: "station_b", system_id: "s1" })
    expect(eventFingerprint(a).full).not.toBe(eventFingerprint(b).full)
    expect(eventFingerprint(a).type).toBe(eventFingerprint(b).type) // same family
  })
  it("falls back to exact-text keying on an unparseable payload", () => {
    expect(eventFingerprint("type: raw\nnot json").full).toBe(eventFingerprint("type: raw\nnot json").full)
    expect(eventFingerprint("type: raw\nnot json").full).not.toBe(eventFingerprint("type: raw\nother").full)
  })

  // ── Deep salient extraction (real full_state shape) ────────────────────────
  // full_state carries location/ship state NESTED (location.system_id,
  // ship.fuel/max_fuel), so its only top-level scalars are `version`/`message`.
  // Before the deep allowlist, EVERY full_state fingerprinted identically and a
  // 6-system bridge run deduped every snapshot ("duplicate 41x"). These paths
  // are lifted from real players/vcarl events.jsonl (04:42-05:08Z).
  const fullState = (over: {
    system?: string
    poi?: string
    docked?: string | null
    fuel?: number
    hull?: number
    shield?: number
  }): string =>
    evText("full_state", {
      version: "0.493.0",
      player: { id: "fd3d78ba", username: "vcarl", credits: 80083 },
      ship: {
        id: "s1",
        hull: over.hull ?? 100,
        max_hull: 100,
        shield: over.shield ?? 50,
        max_shield: 50,
        fuel: over.fuel ?? 49,
        max_fuel: 100,
        cargo_used: 3,
      },
      location: {
        system_id: over.system ?? "first_step",
        system_name: "First Step",
        poi_id: over.poi ?? "first_step_memorial_station",
        poi_type: "station",
        docked_at: over.docked === undefined ? "first_step_memorial_station" : over.docked,
        nearby_player_count: 4,
        nearby_players: [{ player_id: "aaa" }, { player_id: "bbb" }],
      },
      message: "Current game state",
    })

  it("gives two full_states differing ONLY by nested system_id different fingerprints", () => {
    const a = fullState({ system: "first_step" })
    const b = fullState({ system: "horizon" })
    expect(eventFingerprint(a).full).not.toBe(eventFingerprint(b).full)
    expect(eventFingerprint(a).type).toBe(eventFingerprint(b).type) // same family
  })

  it("keys two full_states identical except tick/timestamp/transient nested arrays the same", () => {
    // Same location + same coarse ship bands; only volatile frame data + the
    // shifting nearby_players list differ → must still collapse.
    const a = evText("full_state", {
      version: "0.493.0",
      ship: { fuel: 49, max_fuel: 100, hull: 100, max_hull: 100, shield: 50, max_shield: 50 },
      location: {
        system_id: "first_step",
        poi_id: "first_step_memorial_station",
        docked_at: "first_step_memorial_station",
        nearby_players: [{ player_id: "aaa" }],
      },
      tick: 1000,
      timestamp: "2026-07-13T04:43:00Z",
    })
    const b = evText("full_state", {
      version: "0.493.0",
      ship: { fuel: 49, max_fuel: 100, hull: 100, max_hull: 100, shield: 50, max_shield: 50 },
      location: {
        system_id: "first_step",
        poi_id: "first_step_memorial_station",
        docked_at: "first_step_memorial_station",
        nearby_players: [{ player_id: "bbb" }, { player_id: "ccc" }],
      },
      tick: 9999,
      timestamp: "2026-07-13T05:07:00Z",
    })
    expect(eventFingerprint(a).full).toBe(eventFingerprint(b).full)
  })

  it("distinguishes a dock-state change (docked → undocked at same poi)", () => {
    const docked = fullState({ docked: "first_step_memorial_station" })
    const undocked = fullState({ docked: null })
    expect(eventFingerprint(docked).full).not.toBe(eventFingerprint(undocked).full)
  })

  it("distinguishes a moved poi within the same system", () => {
    const a = fullState({ poi: "first_step_memorial_station" })
    const b = fullState({ poi: "first_step_gate" })
    expect(eventFingerprint(a).full).not.toBe(eventFingerprint(b).full)
  })

  it("buckets gradual fuel drain: 96% and 94% are the same coarse band → same fingerprint", () => {
    const a = fullState({ fuel: 96 }) // ratio 0.96 → band 9
    const b = fullState({ fuel: 94 }) // ratio 0.94 → band 9
    expect(eventFingerprint(a).full).toBe(eventFingerprint(b).full)
  })

  it("distinguishes a real fuel drop across bands: 96% vs 71% → different fingerprint", () => {
    const a = fullState({ fuel: 96 }) // band 9
    const b = fullState({ fuel: 71 }) // band 7
    expect(eventFingerprint(a).full).not.toBe(eventFingerprint(b).full)
  })

  it("distinguishes a combat flip on the player's own status", () => {
    const calm = evText("full_state", {
      ship: { fuel: 50, max_fuel: 100 },
      location: { system_id: "s1", poi_id: "p1" },
      in_combat: false,
    })
    const fighting = evText("full_state", {
      ship: { fuel: 50, max_fuel: 100 },
      location: { system_id: "s1", poi_id: "p1" },
      in_combat: true,
    })
    expect(eventFingerprint(calm).full).not.toBe(eventFingerprint(fighting).full)
  })

  it("still collapses same-station observation_updates (top-level scalars unaffected)", () => {
    // Regression: the deep allowlist must not re-admit the churn the top-level
    // scan already kills. observation_update keeps system_id/poi_id top-level.
    const a = evText("observation_update", {
      poi_id: "first_step_memorial_station",
      system_id: "first_step",
      tick: 1,
      nearby_changed: [{ player_id: "aaa" }],
    })
    const b = evText("observation_update", {
      poi_id: "first_step_memorial_station",
      system_id: "first_step",
      tick: 2,
      nearby_changed: [{ player_id: "bbb" }, { player_id: "ccc" }],
    })
    expect(eventFingerprint(a).full).toBe(eventFingerprint(b).full)
  })
})

describe("isChatEventType", () => {
  it("matches chat / message families, not others", () => {
    expect(isChatEventType("chat")).toBe(true)
    expect(isChatEventType("chat_message")).toBe(true)
    expect(isChatEventType("player_message")).toBe(true)
    expect(isChatEventType("observation_update")).toBe(false)
    expect(isChatEventType("combat")).toBe(false)
  })
})

describe("composeDigestedEventText", () => {
  it("inserts the digest under the `type:` line, above the raw JSON", () => {
    const text = 'type: full_state\n{"ship":{"fuel":6}}'
    expect(composeDigestedEventText(text, "STATUS: fuel 6% (LOW)")).toBe(
      'type: full_state\nSTATUS: fuel 6% (LOW)\n{"ship":{"fuel":6}}',
    )
  })
  it("keeps a trailing dedup suffix at the end", () => {
    const text = "type: full_state\n{} (seen 6x recently)"
    expect(composeDigestedEventText(text, "STATUS: fuel 84%")).toBe(
      "type: full_state\nSTATUS: fuel 84%\n{} (seen 6x recently)",
    )
  })
  it("returns the text unchanged for an empty digest", () => {
    const text = "type: chat\n{}"
    expect(composeDigestedEventText(text, "")).toBe(text)
  })
  it("prepends when the text has no leading `type:` line", () => {
    expect(composeDigestedEventText("bare event", "STATUS: x")).toBe("STATUS: x\nbare event")
  })
})

describe("countRecentFingerprints (sliding window)", () => {
  const fp = { type: "observation_update", full: "observation_update poi_id=x" }
  it("counts exact + type-family occurrences within the window", () => {
    const recent = [
      { full: "observation_update poi_id=x", type: "observation_update", tick: 5 },
      { full: "observation_update poi_id=y", type: "observation_update", tick: 6 }, // same type, different payload
      { full: "chat abc", type: "chat", tick: 7 },
    ]
    const { exactCount, typeCount } = countRecentFingerprints(recent, fp, 8, DEDUP_WINDOW_TICKS)
    expect(exactCount).toBe(1)
    expect(typeCount).toBe(2)
  })
  it("excludes entries older than the window", () => {
    const recent = [{ full: "observation_update poi_id=x", type: "observation_update", tick: 1 }]
    const { exactCount, typeCount } = countRecentFingerprints(recent, fp, 1 + DEDUP_WINDOW_TICKS + 1, DEDUP_WINDOW_TICKS)
    expect(exactCount).toBe(0)
    expect(typeCount).toBe(0)
  })
})

describe("summarizeEventText (Task 4a)", () => {
  it("renders a compact `type: <first ~80 chars>` label", () => {
    const s = summarizeEventText(evText("combat", { attacker: "pirate", damage: 12 }))
    expect(s.startsWith("combat: ")).toBe(true)
    expect(s.length).toBeLessThanOrEqual("combat: ".length + 81)
  })
  it("returns '' for a null event (no dominant)", () => {
    expect(summarizeEventText(null)).toBe("")
  })
})

describe("planTitleFromHeadline (Task 3)", () => {
  it("prefixes the orient headline with '(assessment) '", () => {
    expect(planTitleFromHeadline("Drifted to isolated Horizon system")).toBe(
      "(assessment) Drifted to isolated Horizon system",
    )
  })
  it("is idempotent (never double-prefixes)", () => {
    expect(planTitleFromHeadline("(assessment) already tagged")).toBe("(assessment) already tagged")
  })
  it("tolerates an empty headline", () => {
    expect(planTitleFromHeadline("   ")).toBe("(assessment)")
  })
  it("scrubs volatile ship metrics from the persisted assessment line (Task 2)", () => {
    expect(planTitleFromHeadline("Docked at First Step with full fuel and hull, planning trade run")).toBe(
      "(assessment) Docked at First Step, planning trade run",
    )
  })
})

// Task 1 — control-plane clamp + unsupported-threat downgrade.
const baseObserve = (over: Partial<ObserveResult> = {}): ObserveResult => ({
  disposition: "accumulate",
  emotionalWeight: "😐",
  drive: null,
  weight: 0,
  interrupt: false,
  reason: "",
  ...over,
})

describe("isControlPlaneEventType", () => {
  it("recognizes lifecycle/handshake frames (case-insensitive)", () => {
    for (const t of ["welcome", "logged_in", "LOGGED_IN", "registered", "ok", "result", "action_result", "reconnected"]) {
      expect(isControlPlaneEventType(t)).toBe(true)
    }
  })
  it("excludes game-state and error frames", () => {
    for (const t of ["full_state", "combat", "observation_update", "chat", "error", "action_error", "api_error"]) {
      expect(isControlPlaneEventType(t)).toBe(false)
    }
  })
})

describe("clampControlPlaneAppraisal (Task 1 — control-plane cap)", () => {
  it("clamps a hallucinated w=4 steer on a logged_in frame to a non-escalating accumulate", () => {
    // The overnight-run defect: 2B appraised the logged_in handshake as a threat.
    const event = 'type: logged_in\n{"player":{"pos":"first_step"},"ship":{"hull":100,"max_hull":100}}'
    const { observe, clamped } = clampControlPlaneAppraisal(
      event,
      baseObserve({ disposition: "escalate", drive: "safety", weight: 4, interrupt: false, reason: "Hull damage taken — safety, must react." }),
    )
    expect(clamped).toBe(true)
    expect(observe.weight).toBeLessThanOrEqual(CONTROL_PLANE_MAX_WEIGHT)
    expect(observe.disposition).toBe("accumulate")
    expect(observe.interrupt).toBe(false)
    // Fix 3: the fabricated "Hull damage taken…" claim must NOT survive verbatim.
    // The rewritten reason leads with an accurate control-plane clause and keeps
    // the model's claim only as a truncated `model claimed:` provenance suffix.
    expect(observe.reason.startsWith("control-plane event (guard: clamped from w4;")).toBe(true)
    expect(observe.reason).toContain("model claimed: Hull damage taken")
    expect(observe.reason.startsWith("Hull damage")).toBe(false)
  })
  it("also strips a fabricated interrupt on a welcome frame", () => {
    const { observe, clamped } = clampControlPlaneAppraisal(
      'type: welcome\n{"tick_rate":30}',
      baseObserve({ weight: 5, disposition: "escalate", interrupt: true }),
    )
    expect(clamped).toBe(true)
    expect(observe.weight).toBeLessThanOrEqual(CONTROL_PLANE_MAX_WEIGHT)
    expect(observe.interrupt).toBe(false)
  })
  it("leaves a well-behaved low-weight control-plane appraisal untouched (no spurious clamp)", () => {
    const orig = baseObserve({ weight: 1, disposition: "accumulate" })
    const { observe, clamped } = clampControlPlaneAppraisal('type: logged_in\n{}', orig)
    expect(clamped).toBe(false)
    expect(observe).toBe(orig)
  })
  it("does not touch a non-control-plane frame", () => {
    const orig = baseObserve({ weight: 5, disposition: "escalate", interrupt: true })
    const { clamped } = clampControlPlaneAppraisal('type: combat\n{"hull":-30}', orig)
    expect(clamped).toBe(false)
  })
})

describe("hasCombatEvidence (Task 1)", () => {
  it("is true for a combat frame type", () => {
    expect(hasCombatEvidence('type: combat\n{"event":"weapons_fire","target":"you","hull":-30}')).toBe(true)
    expect(hasCombatEvidence('type: battle_update\n{}')).toBe(true)
    expect(hasCombatEvidence('type: player_died\n{}')).toBe(true)
  })
  it("is true when a payload carries a negative hull/shield delta", () => {
    expect(hasCombatEvidence('type: full_state\n{"ship":{"hull":-12}}')).toBe(true)
  })
  it("is false for a full-hull lifecycle/state frame (no delta)", () => {
    expect(hasCombatEvidence('type: logged_in\n{"ship":{"hull":100,"max_hull":100}}')).toBe(false)
    expect(hasCombatEvidence('type: full_state\n{"ship":{"hull":100,"shield":50}}')).toBe(false)
  })

  it("treats battle_alert / battle_started / base_raid_update as combat frames on TYPE alone", () => {
    // Spec A §7c: these are real combat-family frames the set omitted, so a
    // genuine safety escalation on one of them fell through to the payload scan
    // and — with no numeric harm signal — was downgraded as an unsupported threat.
    expect(hasCombatEvidence('type: battle_alert\n{"payload":{"message":"hostiles inbound"}}')).toBe(true)
    expect(hasCombatEvidence('type: battle_started\n{"payload":{"battle_id":"b1"}}')).toBe(true)
    expect(hasCombatEvidence('type: base_raid_update\n{"payload":{"base_id":"x"}}')).toBe(true)
  })

  it("still requires payload evidence for a genuinely non-combat frame type", () => {
    expect(hasCombatEvidence('type: market_update\n{"payload":{"item":"ore","price":12}}')).toBe(false)
  })
})

describe("downgradeUnsupportedThreat (Task 1)", () => {
  it("downgrades a safety w=5 escalation with no supporting field", () => {
    const event = 'type: full_state\n{"ship":{"hull":100,"max_hull":100},"docked":true}'
    const { observe, downgraded } = downgradeUnsupportedThreat(
      event,
      baseObserve({ drive: "safety", weight: 5, disposition: "escalate", interrupt: false, reason: "Taking hull damage now — under attack." }),
    )
    expect(downgraded).toBe(true)
    expect(observe.weight).toBe(UNSUPPORTED_THREAT_WEIGHT)
    expect(observe.disposition).toBe("accumulate")
    expect(observe.interrupt).toBe(false)
    // Fix 3: the fabricated safety claim must not persist — drive nulled, reason
    // rewritten to lead with an accurate clause + truncated provenance suffix.
    expect(observe.drive).toBeNull()
    expect(observe.reason.startsWith("unsupported threat (guard: downgraded from w5;")).toBe(true)
    expect(observe.reason).toContain("model claimed: Taking hull damage now")
    expect(observe.reason.startsWith("Taking hull")).toBe(false)
  })
  it("leaves a genuine combat escalation (hull delta) untouched", () => {
    const event = 'type: combat\n{"event":"weapons_fire","target":"you","hull":-30}'
    const orig = baseObserve({ drive: "safety", weight: 5, disposition: "escalate", interrupt: false, reason: "Taking hull fire now — under attack, must react." })
    const { observe, downgraded } = downgradeUnsupportedThreat(event, orig)
    expect(downgraded).toBe(false)
    expect(observe).toBe(orig)
  })
  it("NEVER downgrades an interrupt:true appraisal, even with no recognizable combat evidence (protects the hard-interrupt path)", () => {
    // A synthetic/unfamiliar attack frame the payload heuristic can't parse — the
    // model's interrupt flag is authoritative; silencing it would suppress a real attack.
    const event = 'type: attack-now\n{"from":"raider"}'
    const orig = baseObserve({ drive: "safety", weight: 5, disposition: "escalate", interrupt: true, reason: "under fire right now" })
    const { observe, downgraded } = downgradeUnsupportedThreat(event, orig)
    expect(downgraded).toBe(false)
    expect(observe).toBe(orig)
  })
  it("does not touch a non-safety or non-threat-claim escalation", () => {
    // Sustenance escalation (fuel/quota) is a legitimate w=4 that must survive.
    const event = 'type: api_error\n{"status":429,"message":"quota exceeded"}'
    const { downgraded } = downgradeUnsupportedThreat(
      event,
      baseObserve({ drive: "sustenance", weight: 4, disposition: "escalate", reason: "Quota exhausted — pressing resource block." }),
    )
    expect(downgraded).toBe(false)
  })

  it("does NOT downgrade a safety escalation riding a battle_alert with no numeric harm signal", () => {
    // The behavioral consequence of the COMBAT_EVENT_TYPES gap: a real warning
    // frame carries no hull delta and no damage figure, so the guard had nothing
    // to key on and knocked a w=4 safety escalation back to a w=2 accumulate.
    const event = 'type: battle_alert\n{"payload":{"message":"You are being targeted"}}'
    const observe: ObserveResult = {
      disposition: "escalate",
      emotionalWeight: "😰",
      drive: "safety",
      weight: 4,
      interrupt: false,
      reason: "under fire — hostiles have weapons locked",
      source: "model",
    }
    const out = downgradeUnsupportedThreat(event, observe)
    expect(out.downgraded).toBe(false)
    expect(out.observe.weight).toBe(4)
    expect(out.observe.disposition).toBe("escalate")
    expect(out.observe.drive).toBe("safety")
  })
})

describe("guardAppraisal (Task 1 — combined)", () => {
  it("control-plane frame with hallucinated threat → clamped, not double-corrected", () => {
    const event = 'type: logged_in\n{"ship":{"hull":100,"max_hull":100}}'
    const r = guardAppraisal(
      event,
      baseObserve({ drive: "safety", weight: 4, disposition: "escalate", reason: "Hull damage taken — safety, must react." }),
    )
    expect(r.clampedControlPlane).toBe(true)
    expect(r.downgradedThreat).toBe(false)
    expect(r.observe.weight).toBeLessThanOrEqual(CONTROL_PLANE_MAX_WEIGHT)
    expect(r.observe.disposition).toBe("accumulate")
  })
  it("genuine combat event → untouched by either guard", () => {
    const event = 'type: combat\n{"event":"weapons_fire","target":"you","hull":-30}'
    const orig = baseObserve({ drive: "safety", weight: 5, disposition: "escalate", interrupt: true, reason: "Taking hull fire now." })
    const r = guardAppraisal(event, orig)
    expect(r.clampedControlPlane).toBe(false)
    expect(r.downgradedThreat).toBe(false)
    expect(r.observe).toBe(orig)
  })
  it("safety w=5, no supporting field, non-control-plane frame → downgraded", () => {
    const event = 'type: full_state\n{"ship":{"hull":100}}'
    const r = guardAppraisal(
      event,
      baseObserve({ drive: "safety", weight: 5, disposition: "escalate", interrupt: false, reason: "under attack, hull breach" }),
    )
    expect(r.clampedControlPlane).toBe(false)
    expect(r.downgradedThreat).toBe(true)
    expect(r.observe.weight).toBe(UNSUPPORTED_THREAT_WEIGHT)
    // Fix 3 contract: a guarded appraisal never LEADS with the fabricated claim.
    expect(r.observe.reason.startsWith("unsupported threat")).toBe(true)
    expect(r.observe.drive).toBeNull()
  })

  // Fix 3 — provenance suffix behavior.
  it("truncates a long fabricated claim to a ~60-char provenance suffix", () => {
    const longClaim =
      "Hull breach across all decks, boarding party inbound, shields collapsing, total loss imminent — abandon ship now immediately"
    const { observe } = clampControlPlaneAppraisal(
      'type: logged_in\n{}',
      baseObserve({ weight: 5, disposition: "escalate", drive: "safety", reason: longClaim }),
    )
    // The suffix carries at most ~60 chars of the claim (ellipsis on overflow),
    // so the full fabricated sentence never lands in logs/memory verbatim.
    const suffix = observe.reason.split("model claimed: ")[1] ?? ""
    expect(suffix.length).toBeLessThanOrEqual(61) // 59 chars + "…"
    expect(observe.reason).toContain("model claimed: Hull breach")
    expect(observe.reason.endsWith("…)")).toBe(true)
  })
  it("renders (none) when the model supplied no reason", () => {
    const { observe } = clampControlPlaneAppraisal(
      'type: welcome\n{}',
      baseObserve({ weight: 5, disposition: "escalate", reason: "" }),
    )
    expect(observe.reason).toContain("model claimed: (none)")
  })
})

describe("scrubVolatileMetrics (Task 2)", () => {
  it("removes 'full fuel and hull'", () => {
    expect(scrubVolatileMetrics("full fuel and hull")).toBe("")
    expect(scrubVolatileMetrics("Docked with full fuel and hull")).toBe("Docked")
  })
  it("removes a 'fuel 71/100' numeric metric clause", () => {
    expect(scrubVolatileMetrics("fuel 71/100")).toBe("")
    expect(scrubVolatileMetrics("Idle at station, fuel 71/100, hull 100/100")).toBe("Idle at station")
  })
  it("removes '100% hull' / bare-percent forms", () => {
    expect(scrubVolatileMetrics("100% hull")).toBe("")
    expect(scrubVolatileMetrics("hull at 100%")).toBe("")
  })
  it("keeps goal/location content with no volatile metrics", () => {
    expect(scrubVolatileMetrics("install CPU Co-Processor at First Step")).toBe(
      "install CPU Co-Processor at First Step",
    )
  })
})

describe("appraise — the C salience vector", () => {
  const axes = buildAxisSpecs(
    "- safety — your physical integrity\n- voyage — progress",
    "😫 😮‍💨 😐 🤩 🚀 # burdened → exhilarated",
  )

  it("keeps a well-formed vector, clamped per polarity", () => {
    const r = appraise(
      { disposition: "escalate", weight: 5, drive: "safety", salience: { safety: 1.4, "burdened-exhilarated": -0.6 } },
      ["safety", "voyage"],
      axes,
    )
    expect(r.salience).toEqual({ safety: 1, "burdened-exhilarated": -0.6 })
  })

  it("drops an invented axis rather than storing it", () => {
    const r = appraise({ salience: { curiosity: 0.9, safety: 0.3 } }, ["safety"], axes)
    expect(r.salience).toEqual({ safety: 0.3 })
  })

  it("is undefined when no axes are supplied — every existing caller is unaffected", () => {
    expect(appraise({ salience: { safety: 0.5 } }, ["safety"]).salience).toBeUndefined()
    expect(appraise({ weight: 3 }).salience).toBeUndefined()
  })

  it("is {} when the model omitted the field entirely", () => {
    expect(appraise({ weight: 3 }, ["safety"], axes).salience).toEqual({})
  })

  it("never throws on junk", () => {
    expect(appraise({ salience: "lots" }, ["safety"], axes).salience).toEqual({})
    expect(appraise({ salience: [1, 2] }, ["safety"], axes).salience).toEqual({})
  })

  it("collapses an all-zero vector to {} so a no-information C never halves A", () => {
    // The 2B's commonest C output: every axis dutifully scored 0. Kept, it would
    // ship as --dims-c and mergeBaseVector would average it against the
    // mechanical vector — A/2 on every axis (task-12 review, finding 2).
    expect(
      appraise({ salience: { safety: 0, "burdened-exhilarated": 0 } }, ["safety"], axes).salience,
    ).toEqual({})
  })

  it("keeps a mixed vector whose zeros sit beside real readings", () => {
    expect(
      appraise({ salience: { safety: 0, "burdened-exhilarated": -0.6 } }, ["safety"], axes).salience,
    ).toEqual({ safety: 0, "burdened-exhilarated": -0.6 })
  })

  it("does NOT disturb drive, weight, disposition or interrupt — escalation is untouched", () => {
    const withAxes = appraise(
      { disposition: "escalate", weight: 9, drive: "SAFETY", interrupt: "true", reason: "r", salience: { safety: 1 } },
      ["safety"],
      axes,
    )
    const without = appraise(
      { disposition: "escalate", weight: 9, drive: "SAFETY", interrupt: "true", reason: "r" },
      ["safety"],
    )
    expect(withAxes.disposition).toBe(without.disposition)
    expect(withAxes.weight).toBe(without.weight)
    expect(withAxes.drive).toBe(without.drive)
    expect(withAxes.interrupt).toBe(without.interrupt)
    expect(withAxes.reason).toBe(without.reason)
  })
})
