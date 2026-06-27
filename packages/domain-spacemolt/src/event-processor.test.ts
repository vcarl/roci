import { describe, it, expect } from "vitest"
import { spaceMoltEventProcessor } from "./event-processor.js"
import type { GameState } from "./types.js"

/** Minimal GameState fixture for stateUpdate tests. */
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
    tick: 7,
    timestamp: 0,
    ...overrides,
  }
}

describe("spaceMoltEventProcessor — combat_update", () => {
  const combatEvent = {
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

  it("returns an alert with the attacker name when combat is engaged", () => {
    const result = spaceMoltEventProcessor.processEvent(combatEvent, {})
    expect(result.alert).toBeDefined()
    expect(result.alert).toContain("EvilPirate")
  })

  it("stateUpdate sets inCombat true and refreshes tick", () => {
    const result = spaceMoltEventProcessor.processEvent(combatEvent, {})
    const next = result.stateUpdate!(makeState({ inCombat: false, tick: 1 })) as GameState
    expect(next.inCombat).toBe(true)
    expect(next.tick).toBe(42)
  })
})

describe("spaceMoltEventProcessor — non-handled events", () => {
  it("does not return an alert for an unknown 'tick' frame", () => {
    const result = spaceMoltEventProcessor.processEvent({ type: "tick", payload: { tick: 1 } }, {})
    expect(result.alert).toBeUndefined()
  })

  it("returns {} for an unknown/raw future frame without throwing", () => {
    const result = spaceMoltEventProcessor.processEvent(
      { type: "some_future_frame", payload: {} },
      {},
    )
    expect(result).toEqual({})
  })
})

describe("spaceMoltEventProcessor — player_died", () => {
  const event = {
    type: "player_died",
    payload: { respawn_base: "Base1", ship_lost: "Frigate", clone_cost: 100, insurance_payout: 0 },
  }

  it("returns a LifecycleReset category with reason player_died", () => {
    const result = spaceMoltEventProcessor.processEvent(event, {})
    expect(result.category).toEqual({ _tag: "LifecycleReset", reason: "player_died" })
  })

  it("stateUpdate sets inCombat false", () => {
    const result = spaceMoltEventProcessor.processEvent(event, {})
    const next = result.stateUpdate!(makeState({ inCombat: true })) as GameState
    expect(next.inCombat).toBe(false)
  })
})

describe("spaceMoltEventProcessor — chat_message", () => {
  it("puts one entry with channel/sender/content into context.chatMessages", () => {
    const result = spaceMoltEventProcessor.processEvent(
      { type: "chat_message", payload: { channel: "global", sender: "Bob", content: "hi" } },
      {},
    )
    expect(result.context?.chatMessages).toEqual([{ channel: "global", sender: "Bob", content: "hi" }])
  })

  it("defaults missing fields to empty strings without throwing", () => {
    const result = spaceMoltEventProcessor.processEvent({ type: "chat_message", payload: {} }, {})
    expect(result.context?.chatMessages).toEqual([{ channel: "", sender: "", content: "" }])
  })
})

describe("spaceMoltEventProcessor — observation_update", () => {
  it("sets tick, upserts a nearby_changed player, and removes a departed player", () => {
    const event = {
      type: "observation_update",
      payload: {
        tick: 99,
        poi_id: "poi1",
        system_id: "sys1",
        unknown_signature: false,
        nearby_changed: [{ player_id: "p2", username: "NewGuy", ship_class: "Scout", in_combat: true }],
        nearby_departed: ["p1"],
      },
    }
    const prev = makeState({
      tick: 1,
      nearby: [
        {
          player_id: "p1",
          username: "OldGuy",
          ship_class: "Frigate",
          faction_id: null,
          faction_tag: null,
          status_message: "",
          clan_tag: "",
          primary_color: "",
          secondary_color: "",
          anonymous: false,
          in_combat: false,
        },
      ],
    })
    const next = spaceMoltEventProcessor.processEvent(event, {}).stateUpdate!(prev) as GameState
    expect(next.tick).toBe(99)
    const ids = next.nearby.map((n) => n.player_id)
    expect(ids).toContain("p2")
    expect(ids).not.toContain("p1")
    const p2 = next.nearby.find((n) => n.player_id === "p2")!
    expect(p2.username).toBe("NewGuy")
    expect(p2.in_combat).toBe(true)
  })
})

describe("spaceMoltEventProcessor — mining_yield", () => {
  it("increments ship.cargo_used by quantity", () => {
    const event = {
      type: "mining_yield",
      payload: { resource_id: "ore", quantity: 3, remaining: 10, remaining_display: "10" },
    }
    const next = spaceMoltEventProcessor
      .processEvent(event, {})
      .stateUpdate!(makeState({ ship: { cargo_used: 2, cargo_capacity: 10, cargo: [] } as unknown as GameState["ship"] })) as GameState
    expect(next.ship.cargo_used).toBe(5)
  })

  it("clamps ship.cargo_used at cargo_capacity", () => {
    const event = {
      type: "mining_yield",
      payload: { resource_id: "ore", quantity: 50, remaining: 10, remaining_display: "10" },
    }
    const next = spaceMoltEventProcessor
      .processEvent(event, {})
      .stateUpdate!(makeState({ ship: { cargo_used: 8, cargo_capacity: 10, cargo: [] } as unknown as GameState["ship"] })) as GameState
    expect(next.ship.cargo_used).toBe(10)
  })
})

describe("spaceMoltEventProcessor — logged_in", () => {
  it("rebuilds player/ship from the payload", () => {
    const event = {
      type: "logged_in",
      payload: {
        player: { username: "Cmdr" },
        ship: { hull: 55, cargo: [{ item_id: "ore", quantity: 4 }] },
        system: { id: "sys1" },
        poi: null,
      },
    }
    const next = spaceMoltEventProcessor.processEvent(event, {}).stateUpdate!(makeState()) as GameState
    expect(next.player.username).toBe("Cmdr")
    expect(next.ship.hull).toBe(55)
    expect(next.cargo).toEqual([{ item_id: "ore", quantity: 4 }])
  })
})

describe("spaceMoltEventProcessor — scan_detected", () => {
  it("returns an alert naming the scanner", () => {
    const result = spaceMoltEventProcessor.processEvent(
      {
        type: "scan_detected",
        payload: { scanner_username: "Spy", scanner_id: "s1", message: "scanned", revealed_info: [] },
      },
      {},
    )
    expect(result.alert).toContain("Spy")
  })
})

describe("spaceMoltEventProcessor — error", () => {
  it("returns a callable log function", () => {
    const result = spaceMoltEventProcessor.processEvent(
      { type: "error", payload: { code: "x", message: "boom" } },
      {},
    )
    expect(typeof result.log).toBe("function")
    expect(() => result.log!()).not.toThrow()
  })
})
