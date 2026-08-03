import { describe, it, expect } from "vitest"
import { spaceMoltInterruptRegistry } from "./interrupts.js"
import { SituationType } from "./types.js"
import type { GameState, Situation, SituationFlags } from "./types.js"

/** Benign, healthy, undocked, out-of-combat state — trips no state-driven rule. */
function makeState(): GameState {
  return {
    player: { username: "Pilot", docked_at_base: null } as unknown as GameState["player"],
    ship: {
      hull: 100,
      max_hull: 100,
      fuel: 50,
      max_fuel: 50,
      cargo_used: 0,
      cargo_capacity: 10,
      cargo: [],
    } as unknown as GameState["ship"],
    poi: null,
    system: null,
    cargo: [],
    nearby: [],
    notifications: [],
    travelProgress: null,
    inCombat: false,
    connected: true,
    tick: 1,
    timestamp: Date.now(),
  }
}

/** All flags false by default; override the one under test. */
function makeSituation(flags: Partial<SituationFlags> = {}): Situation {
  return {
    type: SituationType.InSpace,
    flags: {
      atMineablePoi: false,
      atDockablePoi: false,
      lowFuel: false,
      cargoNearlyFull: false,
      cargoFull: false,
      lowHull: false,
      hasPendingTrades: false,
      hasUnreadChat: false,
      hasCompletableMission: false,
      ...flags,
    },
  }
}

describe("interrupts — pending_trades", () => {
  it("fires when hasPendingTrades is true", () => {
    const alerts = spaceMoltInterruptRegistry.evaluate(makeState(), makeSituation({ hasPendingTrades: true }))
    const trade = alerts.find((a) => a.ruleName === "pending_trades")
    expect(trade).toBeDefined()
    expect(trade!.priority).toBe("medium")
    expect(trade!.suggestedAction).toBe("get_trades")
  })

  it("does not fire when hasPendingTrades is false", () => {
    const alerts = spaceMoltInterruptRegistry.evaluate(makeState(), makeSituation({ hasPendingTrades: false }))
    expect(alerts.find((a) => a.ruleName === "pending_trades")).toBeUndefined()
  })
})
