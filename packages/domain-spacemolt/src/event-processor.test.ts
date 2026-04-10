import { describe, it, expect } from "vitest"
import { spaceMoltEventProcessor } from "./event-processor.js"

describe("spaceMoltEventProcessor — combat_update", () => {
  it("returns an alert with the attacker name when combat is engaged", () => {
    const event = {
      type: "combat_update",
      payload: {
        tick: 42,
        attacker: "EvilPirate",
        target: "player",
        damage: 50,
        damage_type: "laser",
        shield_hit: 30,
        hull_hit: 20,
        destroyed: false,
      },
    }

    const result = spaceMoltEventProcessor.processEvent(event, {})

    expect(result.alert).toBeDefined()
    expect(result.alert).toContain("EvilPirate")
  })

  it("does not return an alert for non-combat events", () => {
    const event = {
      type: "tick",
      payload: { tick: 1 },
    }

    const result = spaceMoltEventProcessor.processEvent(event, {})

    expect(result.alert).toBeUndefined()
  })
})
