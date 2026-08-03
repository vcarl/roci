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
    connected: true,
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

  it("stateUpdate sets inCombat true and refreshes tick", () => {
    const result = spaceMoltEventProcessor.processEvent(damageEvent, {})
    const next = result.stateUpdate!(makeState({ inCombat: false, tick: 1 })) as GameState
    expect(next.inCombat).toBe(true)
    expect(next.tick).toBe(42)
  })
})

describe("spaceMoltEventProcessor — non-handled events", () => {
  it("returns {} for an unknown 'tick' frame", () => {
    const result = spaceMoltEventProcessor.processEvent({ type: "tick", payload: { tick: 1 } }, {})
    expect(result).toEqual({})
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

describe("spaceMoltEventProcessor — state_sync", () => {
  const sync = (snapshot: Record<string, unknown>, tick?: number) => ({
    type: "state_sync",
    payload: { sections: Object.keys(snapshot), ...(tick !== undefined ? { tick } : {}), snapshot },
  })

  it("folds a translated StateCache snapshot onto the prior state", () => {
    const event = sync({
      player: { credits: 1234, current_system: "sysX", current_poi: "poiX", docked_at_base: null },
      ship: { hull: 40, max_hull: 100, fuel: 12, cargo_used: 6, cargo_capacity: 20 },
      cargo: [{ item_id: "ore", quantity: 6 }],
      system: { id: "sysX", name: "Xanadu" },
      poi: { id: "poiX", name: "Belt X", type: "asteroid_belt" },
    }, 4242)
    const next = spaceMoltEventProcessor.processEvent(event, {}).stateUpdate!(makeState()) as GameState
    expect(next.player.credits).toBe(1234)
    expect(next.ship.hull).toBe(40)
    expect(next.cargo).toEqual([{ item_id: "ore", quantity: 6 }])
    expect(next.player.current_system).toBe("sysX")
    expect(next.player.docked_at_base).toBeNull()
    expect(next.system?.name).toBe("Xanadu")
    expect(next.poi?.type).toBe("asteroid_belt")
    expect(next.tick).toBe(4242)
  })

  it("a sparse snapshot never zeroes state it does not carry", () => {
    const prev = makeState({
      player: { username: "Keep", credits: 500, docked_at_base: null } as unknown as GameState["player"],
      ship: { hull: 88, max_hull: 100, fuel: 9, max_fuel: 50, cargo_used: 4, cargo_capacity: 10, cargo: [{ item_id: "ore", quantity: 4 }] } as unknown as GameState["ship"],
    })
    const next = spaceMoltEventProcessor.processEvent(sync({ ship: { fuel: 3 } }), prev).stateUpdate!(prev) as GameState
    expect(next.player.username).toBe("Keep")
    expect(next.player.credits).toBe(500)
    expect(next.ship.hull).toBe(88)
    expect(next.ship.fuel).toBe(3)
    expect(next.cargo).toEqual([{ item_id: "ore", quantity: 4 }])
  })

  it("merges fresh names onto the existing poi object when the id is unchanged", () => {
    const prev = makeState({
      poi: { id: "poiX", name: "old", type: "asteroid_belt", base_id: "baseX" } as unknown as GameState["poi"],
    })
    const next = spaceMoltEventProcessor
      .processEvent(sync({ poi: { id: "poiX", name: "Belt X Renamed" } }), prev)
      .stateUpdate!(prev) as GameState
    expect(next.poi?.name).toBe("Belt X Renamed")
    // base_id preserved — merge-by-id keeps fields a leaner snapshot lacks.
    expect((next.poi as unknown as { base_id?: string }).base_id).toBe("baseX")
  })

  it("replaces the poi wholesale when the id changed", () => {
    const prev = makeState({
      poi: { id: "poiX", name: "old", type: "station", base_id: "baseX" } as unknown as GameState["poi"],
    })
    const next = spaceMoltEventProcessor
      .processEvent(sync({ poi: { id: "poiY", name: "Belt Y", type: "asteroid_belt" } }), prev)
      .stateUpdate!(prev) as GameState
    expect(next.poi?.id).toBe("poiY")
    expect((next.poi as unknown as { base_id?: string }).base_id).toBeUndefined()
  })

  it("is a NO-OP for a malformed frame carrying no snapshot — never a state wipe", () => {
    expect(spaceMoltEventProcessor.processEvent({ type: "state_sync", payload: {} }, {})).toEqual({})
    expect(spaceMoltEventProcessor.processEvent({ type: "state_sync" }, {})).toEqual({})
  })
})

describe("spaceMoltEventProcessor — connection_state", () => {
  it("sets connected false on a disconnect and true on a reconnect", () => {
    const down = spaceMoltEventProcessor
      .processEvent({ type: "connection_state", payload: { connected: false, phase: "disconnected", reason: "going away" } }, {})
      .stateUpdate!(makeState()) as GameState
    expect(down.connected).toBe(false)

    const up = spaceMoltEventProcessor
      .processEvent({ type: "connection_state", payload: { connected: true, phase: "connected" } }, {})
      .stateUpdate!(down) as GameState
    expect(up.connected).toBe(true)
  })

  it("treats a reconnecting frame as NOT connected", () => {
    const s = spaceMoltEventProcessor
      .processEvent({ type: "connection_state", payload: { connected: false, phase: "reconnecting", attempt: 2 } }, {})
      .stateUpdate!(makeState()) as GameState
    expect(s.connected).toBe(false)
  })

  it("is NOT a LifecycleReset — a dropped socket must not void the plan", () => {
    // The library reconnects, re-authenticates and re-subscribes by itself. The
    // character should be told its data is stale, not have its work destroyed.
    const r = spaceMoltEventProcessor.processEvent(
      { type: "connection_state", payload: { connected: false, phase: "disconnected" } }, {},
    )
    expect(r.category).toEqual({ _tag: "StateChange" })
  })

  it("defaults to disconnected for a malformed payload rather than claiming health", () => {
    const s = spaceMoltEventProcessor
      .processEvent({ type: "connection_state", payload: {} }, {})
      .stateUpdate!(makeState()) as GameState
    expect(s.connected).toBe(false)
  })
})

describe("spaceMoltEventProcessor — frames the library no longer delivers", () => {
  it("logged_in is a no-op: the library consumes it internally to complete auth", () => {
    expect(spaceMoltEventProcessor.processEvent({ type: "logged_in", payload: { player: {} } }, {})).toEqual({})
  })

  it("full_state is a no-op: it never existed on the wire", () => {
    expect(spaceMoltEventProcessor.processEvent({ type: "full_state", payload: { ship: { fuel: 3 } } }, {})).toEqual({})
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

describe("spaceMoltEventProcessor — scan_detected", () => {
  it("is a no-op for the host: the raw frame reaches the hindbrain on its own", () => {
    // Spec A §6c: being scanned is exactly the event whose importance depends on
    // who you are, so it goes through appraisal rather than a host-side alert.
    const result = spaceMoltEventProcessor.processEvent(
      {
        type: "scan_detected",
        payload: { scanner_username: "Spy", scanner_id: "s1", message: "scanned", revealed_info: [] },
      },
      {},
    )
    expect(result).toEqual({})
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
