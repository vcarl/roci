import { describe, it, expect } from "vitest"
import { classifySituation } from "./situation-classifier.js"
import type { GameState } from "./types.js"
import { SituationType } from "./types.js"

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
    inCombat: false,
    connected: true,
    combat: { lastEventTick: null, onsetSeq: 0 },
    deathPending: false,
    tick: 1,
    timestamp: Date.now(),
    ...overrides,
  }
}

describe("classifySituation — atMineablePoi (the one surviving flag)", () => {
  it("is true at a mineable POI type", () => {
    const poi = { id: "p", type: "asteroid_belt", name: "Belt", base_id: null } as unknown as GameState["poi"]
    expect(classifySituation(makeState({ poi })).flags.atMineablePoi).toBe(true)
  })

  it("is false at a station", () => {
    const poi = { id: "p", type: "station", name: "Station", base_id: "b" } as unknown as GameState["poi"]
    expect(classifySituation(makeState({ poi })).flags.atMineablePoi).toBe(false)
  })

  it("is false in open space with no POI", () => {
    expect(classifySituation(makeState({ poi: null })).flags.atMineablePoi).toBe(false)
  })

  it("is the ONLY flag — the other eight had zero consumers once interrupts.ts died", () => {
    expect(Object.keys(classifySituation(makeState()).flags)).toEqual(["atMineablePoi"])
  })
})

describe("classifySituation — type", () => {
  it("combat wins over everything", () => {
    expect(classifySituation(makeState({ inCombat: true })).type).toBe(SituationType.InCombat)
  })

  it("docked when a base is set, in_space otherwise", () => {
    const docked = { username: "Pilot", docked_at_base: "baseA" } as unknown as GameState["player"]
    expect(classifySituation(makeState({ player: docked })).type).toBe(SituationType.Docked)
    expect(classifySituation(makeState()).type).toBe(SituationType.InSpace)
  })

  it("has no in_transit member — travelProgress never had a writer", () => {
    expect(Object.values(SituationType)).toEqual(["docked", "in_space", "in_combat"])
  })
})
