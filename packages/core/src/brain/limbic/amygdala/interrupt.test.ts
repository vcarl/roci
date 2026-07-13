import { describe, it, expect } from "vitest"
import { createInterruptRegistry, type InterruptRule } from "./interrupt.js"

// Minimal rules over a trivial "state" shape (the registry is domain-agnostic).
type S = { critical: boolean; soft: boolean; docked: boolean }
const rule = (over: Partial<InterruptRule> & Pick<InterruptRule, "name" | "priority" | "condition">): InterruptRule => ({
  message: () => `${over.name} fired`,
  ...over,
})

const rules: InterruptRule[] = [
  rule({ name: "hull_critical", priority: "critical", condition: (s) => (s as unknown as S).critical }),
  rule({
    name: "fuel_low_docked",
    priority: "low",
    condition: (s) => (s as unknown as S).soft,
    suggestedAction: "refuel",
    suppressWhenTaskIs: "refuel",
  }),
]

const registry = createInterruptRegistry(rules)
const sit = {} as never

describe("InterruptRegistry.explain", () => {
  it("returns [] when no rule matches", () => {
    expect(registry.explain({ critical: false, soft: false, docked: true } as never, sit)).toEqual([])
  })

  it("marks a matched critical rule as fired and routes it to the conscious tier", () => {
    const out = registry.explain({ critical: true, soft: false, docked: false } as never, sit)
    expect(out).toEqual([{ ruleName: "hull_critical", priority: "critical", outcome: "fired", tier: "conscious" }])
  })

  it("marks a matched non-critical rule as below-threshold with tier none", () => {
    const out = registry.explain({ critical: false, soft: true, docked: true } as never, sit)
    expect(out).toEqual([
      { ruleName: "fuel_low_docked", priority: "low", outcome: "below-threshold", tier: "none" },
    ])
  })

  it("marks a rule suppressed by the current task", () => {
    const out = registry.explain({ critical: false, soft: true, docked: true } as never, sit, "refuel")
    expect(out).toEqual([
      { ruleName: "fuel_low_docked", priority: "low", outcome: "suppressed-by-task:refuel", tier: "none" },
    ])
  })

  it("records every matched rule in a single tick", () => {
    const out = registry.explain({ critical: true, soft: true, docked: true } as never, sit)
    expect(out.map((r) => r.ruleName)).toEqual(["hull_critical", "fuel_low_docked"])
  })
})
