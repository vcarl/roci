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

describe("spaceMoltEventProcessor — battle_update", () => {
  // client-v2 1.6.0: `combat_update` (per-hit) became `battle_update` (periodic
  // battle-state snapshot). No attacker/damage fields on the WS stream anymore.
  const combatEvent = {
    type: "battle_update",
    payload: {
      auto_pilot: false,
      battle_id: "b-1",
      tick: 42,
      your_side_id: 0,
      your_stance: "aggressive",
      your_zone: "orbit",
      participants: [
        { player_id: "me", username: "Pilot", side_id: 0, zone: "orbit" },
        { player_id: "foe", username: "EvilPirate", side_id: 1, zone: "orbit" },
      ],
      sides: [
        { side_id: 0, player_count: 1 },
        { side_id: 1, player_count: 1 },
      ],
    },
  }

  it("returns an alert summarizing the standing battle", () => {
    const result = spaceMoltEventProcessor.processEvent(combatEvent, {})
    expect(result.alert).toBeDefined()
    expect(result.alert).toContain("1 hostile")
    expect(result.alert).toContain("aggressive")
  })

  it("stateUpdate sets inCombat true and refreshes tick", () => {
    const result = spaceMoltEventProcessor.processEvent(combatEvent, {})
    const next = result.stateUpdate!(makeState({ inCombat: false, tick: 1 })) as GameState
    expect(next.inCombat).toBe(true)
    expect(next.tick).toBe(42)
  })
})

describe("spaceMoltEventProcessor — battle_damage", () => {
  // `battle_damage` is a per-hit combat frame the lib's ServerEvent union omits;
  // GameEvent bridges it so this fixture typechecks and the processor handles it.
  const damageEvent = {
    type: "battle_damage" as const,
    payload: {
      attacker_id: "foe",
      attacker_name: "EvilPirate",
      damage_type: "laser",
      hit_success: true,
      hull_hit: 20,
      shield_hit: 30,
      target_id: "me",
      target_name: "Pilot",
      tick: 42,
      total_damage: 50,
      weapons_fired: [],
    },
  }

  it("returns an alert naming the attacker and total damage", () => {
    const result = spaceMoltEventProcessor.processEvent(damageEvent, {})
    expect(result.alert).toBeDefined()
    expect(result.alert).toContain("EvilPirate")
    expect(result.alert).toContain("50")
  })

  it("stateUpdate sets inCombat true and refreshes tick", () => {
    const result = spaceMoltEventProcessor.processEvent(damageEvent, {})
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

  it("folds poi_id/system_id into the player so location stays fresh", () => {
    const event = {
      type: "observation_update",
      payload: { tick: 100, poi_id: "poiB", system_id: "sysB", unknown_signature: false },
    }
    const prev = makeState({
      player: { current_poi: "poiA", current_system: "sysA", docked_at_base: null } as unknown as GameState["player"],
    })
    const next = spaceMoltEventProcessor.processEvent(event, {}).stateUpdate!(prev) as GameState
    expect(next.player.current_poi).toBe("poiB")
    expect(next.player.current_system).toBe("sysB")
    // Unrelated player fields are preserved (merge, not replace).
    expect(next.player.docked_at_base).toBeNull()
  })
})

describe("spaceMoltEventProcessor — full_state refresh", () => {
  it("flows a get_state snapshot through the same merge as logged_in", () => {
    const event = {
      type: "full_state",
      payload: {
        player: { username: "Cmdr", credits: 1234 },
        ship: { hull: 40, max_hull: 100, fuel: 12, cargo_used: 6, cargo_capacity: 20 },
        cargo: [{ item_id: "ore", quantity: 6 }],
        location: { system_id: "sysX", system_name: "Xanadu", poi_id: "poiX", poi_name: "Belt X", poi_type: "asteroid_belt", docked_at: null },
      },
    }
    const next = spaceMoltEventProcessor.processEvent(event, {}).stateUpdate!(makeState()) as GameState
    expect(next.player.credits).toBe(1234)
    expect(next.ship.hull).toBe(40)
    expect(next.ship.cargo_used).toBe(6)
    expect(next.cargo).toEqual([{ item_id: "ore", quantity: 6 }])
    // location → player fields
    expect(next.player.current_system).toBe("sysX")
    expect(next.player.current_poi).toBe("poiX")
    expect(next.player.docked_at_base).toBeNull()
    // minimal system/poi objects carry fresh names/type
    expect(next.system?.name).toBe("Xanadu")
    expect(next.poi?.name).toBe("Belt X")
    expect(next.poi?.type).toBe("asteroid_belt")
    // full-state stamp advanced for the age indicator
    expect(typeof next.lastFullStateAt).toBe("number")
  })

  it("unwraps a structuredContent envelope", () => {
    const event = {
      type: "full_state",
      payload: { structuredContent: { ship: { fuel: 3 }, location: { poi_id: "p", system_id: "s" } } },
    }
    const next = spaceMoltEventProcessor.processEvent(event, {}).stateUpdate!(makeState()) as GameState
    expect(next.ship.fuel).toBe(3)
    expect(next.player.current_poi).toBe("p")
  })

  it("an empty/degraded refresh payload never zeroes prior state", () => {
    const prev = makeState({
      player: { username: "Keep", credits: 500, docked_at_base: null } as unknown as GameState["player"],
      ship: { hull: 88, max_hull: 100, fuel: 9, max_fuel: 50, cargo_used: 4, cargo_capacity: 10, cargo: [{ item_id: "ore", quantity: 4 }] } as unknown as GameState["ship"],
    })
    const next = spaceMoltEventProcessor.processEvent({ type: "full_state", payload: {} }, prev).stateUpdate!(prev) as GameState
    expect(next.player.username).toBe("Keep")
    expect(next.player.credits).toBe(500)
    expect(next.ship.hull).toBe(88)
    expect(next.ship.cargo_used).toBe(4)
    expect(next.cargo).toEqual([{ item_id: "ore", quantity: 4 }])
    // still stamps a fresh full-state time (successful, if empty, refresh)
    expect(typeof next.lastFullStateAt).toBe("number")
  })

  it("merges fresh names onto the existing poi object when the id is unchanged", () => {
    const prev = makeState({
      poi: { id: "poiX", name: "old", type: "asteroid_belt", base_id: "baseX" } as unknown as GameState["poi"],
    })
    const event = {
      type: "full_state",
      payload: { location: { poi_id: "poiX", poi_name: "Belt X Renamed", system_id: "sysX" } },
    }
    const next = spaceMoltEventProcessor.processEvent(event, prev).stateUpdate!(prev) as GameState
    expect(next.poi?.name).toBe("Belt X Renamed")
    // base_id preserved from the prior object (merge-by-id keeps fields get_state lacks)
    expect((next.poi as unknown as { base_id?: string }).base_id).toBe("baseX")
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

  it("stores pending_trades from the handshake payload", () => {
    const event = {
      type: "logged_in",
      payload: {
        player: { username: "Cmdr" },
        ship: { hull: 55 },
        system: { id: "sys1" },
        poi: null,
        pending_trades: [{ trade_id: "t1", offerer_name: "Bob" }],
      },
    }
    const next = spaceMoltEventProcessor.processEvent(event, {}).stateUpdate!(makeState()) as GameState
    expect(next.pendingTrades).toEqual([{ trade_id: "t1", offerer_name: "Bob" }])
  })

  it("defaults pending_trades to an empty array when the payload omits it", () => {
    const event = {
      type: "logged_in",
      payload: { player: { username: "Cmdr" }, ship: { hull: 55 }, system: { id: "sys1" }, poi: null },
    }
    const next = spaceMoltEventProcessor.processEvent(event, {}).stateUpdate!(makeState()) as GameState
    expect(next.pendingTrades).toEqual([])
  })

  it("a get_state full_state refresh preserves prior pending_trades (it never carries them)", () => {
    const prev = makeState({ pendingTrades: [{ trade_id: "t1" }] })
    const next = spaceMoltEventProcessor
      .processEvent({ type: "full_state", payload: { ship: { fuel: 3 } } }, prev)
      .stateUpdate!(prev) as GameState
    expect(next.pendingTrades).toEqual([{ trade_id: "t1" }])
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
