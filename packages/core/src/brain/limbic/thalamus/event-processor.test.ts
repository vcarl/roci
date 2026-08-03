import { describe, it, expect } from "vitest"
import { runDeterministicAppraisers, type EventProcessor } from "./event-processor.js"
import type { ObserveResult } from "../../../skills/types.js"

/** A well-formed rule output with just the field under test overridden. */
const ruleResult = (o: Partial<ObserveResult> = {}): ObserveResult => ({
  disposition: "accumulate",
  emotionalWeight: "😐",
  drive: null,
  weight: 2,
  interrupt: false,
  reason: "rule fired",
  ...o,
})

/** A processor whose processEvent is inert — only the appraisers matter here. */
const processorWith = (
  appraisers?: EventProcessor["deterministicAppraisers"],
): EventProcessor => ({
  processEvent: () => ({}),
  ...(appraisers ? { deterministicAppraisers: appraisers } : {}),
})

describe("runDeterministicAppraisers", () => {
  it("returns [] for a domain that registers no appraisers at all", () => {
    expect(runDeterministicAppraisers(processorWith(), {}, {}).results).toEqual([])
  })

  it("returns [] for a domain that registers an empty array", () => {
    expect(runDeterministicAppraisers(processorWith([]), {}, {}).results).toEqual([])
  })

  it("drops null results and keeps non-null ones, in registration order", () => {
    const { results: out } = runDeterministicAppraisers(
      processorWith([
        () => ruleResult({ reason: "first" }),
        () => null,
        () => ruleResult({ reason: "third" }),
      ]),
      {},
      {},
    )
    expect(out.map((o) => o.reason)).toEqual(["first", "third"])
  })

  it("stamps source:'deterministic' even when the rule claims otherwise", () => {
    // The stamp is applied HERE, not trusted from the rule, so a domain cannot
    // mint an appraisal that appraiseTick's tie-break treats as model output.
    const { results: out } = runDeterministicAppraisers(
      processorWith([() => ruleResult({ source: "model" }), () => ruleResult({})]),
      {},
      {},
    )
    expect(out.map((o) => o.source)).toEqual(["deterministic", "deterministic"])
  })

  it("passes the tick's state and situation through to each rule", () => {
    const seen: Array<[unknown, unknown]> = []
    runDeterministicAppraisers(
      processorWith([
        (state, situation) => {
          seen.push([state, situation])
          return null
        },
      ]),
      { hull: 12 },
      { type: "in_space" },
    )
    expect(seen).toEqual([[{ hull: 12 }, { type: "in_space" }]])
  })

  it("preserves every other field of the rule's result untouched", () => {
    const [out] = runDeterministicAppraisers(
      processorWith([
        () =>
          ruleResult({
            disposition: "escalate",
            emotionalWeight: "😰",
            drive: "safety",
            weight: 5,
            interrupt: true,
            reason: "RULE: hull 12%",
            salience: { safety: 1 },
          }),
      ]),
      {},
      {},
    ).results
    expect(out).toEqual({
      disposition: "escalate",
      emotionalWeight: "😰",
      drive: "safety",
      weight: 5,
      interrupt: true,
      reason: "RULE: hull 12%",
      salience: { safety: 1 },
      source: "deterministic",
    })
  })

  it("a THROWING rule is skipped, RECORDED, and never propagated", () => {
    // Skipping without recording made a rule that throws every tick look
    // identical to a rule whose condition is simply false, forever.
    const run = runDeterministicAppraisers(
      processorWith([
        () => {
          throw new Error("domain bug")
        },
        () => ruleResult({ reason: "survivor" }),
      ]),
      {},
      {},
    )
    expect(run.results.map((o) => o.reason)).toEqual(["survivor"])
    expect(run.errors).toEqual(["0: domain bug"])
  })

  it("records a non-Error throw too", () => {
    const run = runDeterministicAppraisers(
      processorWith([
        () => {
          throw "just a string"
        },
      ]),
      {},
      {},
    )
    expect(run.errors).toEqual(["0: just a string"])
  })

  it("CLAMPS a rule's result — a domain cannot push weight 99 onto the ladder", () => {
    const [out] = runDeterministicAppraisers(
      processorWith([
        () => ({ ...ruleResult(), weight: 99, disposition: "panic" as never, emotionalWeight: "" }),
      ]),
      {},
      {},
    ).results
    expect(out!.weight).toBe(5)
    expect(out!.disposition).toBe("accumulate")
    expect(out!.emotionalWeight).toBe("😐")
    expect(out!.source).toBe("deterministic")
  })

  it("normalizes the string \"null\" drive so it cannot be read as a real drive", () => {
    const [out] = runDeterministicAppraisers(
      processorWith([() => ({ ...ruleResult(), drive: "null" })]),
      {},
      {},
    ).results
    expect(out!.drive).toBeNull()
  })
})
