import { describe, it, expect } from "vitest"
import { classifySituation } from "./situation-classifier.js"
import type { GameState } from "./types.js"

/** Minimal in-space GameState fixture sufficient for flag derivation. */
function makeState(overrides: Partial<GameState> = {}): GameState {
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
    tick: 1,
    timestamp: Date.now(),
    lastFullStateAt: Date.now(),
    ...overrides,
  }
}

describe("classifySituation — hasPendingTrades", () => {
  it("is true when pendingTrades is non-empty", () => {
    const state = makeState({ pendingTrades: [{ trade_id: "t1" }] })
    expect(classifySituation(state).flags.hasPendingTrades).toBe(true)
  })

  it("is false when pendingTrades is an empty array", () => {
    const state = makeState({ pendingTrades: [] })
    expect(classifySituation(state).flags.hasPendingTrades).toBe(false)
  })

  it("is false when pendingTrades is absent", () => {
    expect(classifySituation(makeState()).flags.hasPendingTrades).toBe(false)
  })
})
