import { describe, it, expect } from "vitest"
import { spaceMoltStateRenderer } from "./renderer.js"
import { spaceMoltSituationClassifier } from "./situation.js"
import type { GameState } from "./types.js"

/** Minimal in-space GameState sufficient for classification + briefing. */
function makeState(overrides: Partial<GameState> = {}): GameState {
  return {
    player: {
      username: "Pilot",
      credits: 100,
      current_poi: "poiA",
      current_system: "sysA",
      docked_at_base: null,
    } as unknown as GameState["player"],
    ship: {
      hull: 80,
      max_hull: 100,
      fuel: 25,
      max_fuel: 50,
      cargo_used: 3,
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
    tick: 512,
    timestamp: Date.now(),
    ...overrides,
  }
}

describe("state bar — tick and liveness instrumentation", () => {
  it("formatStateBar renders the current tick", () => {
    const bar = spaceMoltStateRenderer.formatStateBar({
      situationType: "in_space",
      fuel: 0.5,
      hull: 0.8,
      cargoUsed: 3,
      cargoCapacity: 10,
      inCombat: false,
      tick: 512,
      connected: true,
    })
    expect(bar).toContain("t:512")
  })

  it("says NOTHING about the connection while it is healthy", () => {
    // The token's presence is the whole signal — a bar with no liveness segment
    // is a healthy one, and printing `online` every tick would be noise the 2B
    // has to read past on every single frame.
    const bar = spaceMoltStateRenderer.formatStateBar({ situationType: "docked", tick: 1, connected: true })
    expect(bar).not.toContain("OFFLINE")
    expect(bar).not.toMatch(/age:/)
  })

  it("prints OFFLINE when the live feed is down", () => {
    const bar = spaceMoltStateRenderer.formatStateBar({ situationType: "docked", tick: 1, connected: false })
    expect(bar).toContain("OFFLINE")
  })

  it("summarize surfaces tick and connected in metrics, and those render into the bar", () => {
    const summary = spaceMoltSituationClassifier.summarize(makeState({ tick: 777 }))
    expect(summary.metrics.tick).toBe(777)
    expect(summary.metrics.connected).toBe(true)
    expect(spaceMoltStateRenderer.formatStateBar(summary.metrics)).toContain("t:777")
  })
})

describe("situation — the liveness warning cognition reads", () => {
  it("connected: no warning, plain headline", () => {
    const summary = spaceMoltSituationClassifier.summarize(makeState({ connected: true }))
    expect(summary.metrics.connected).toBe(true)
    expect(summary.headline).not.toContain("OFFLINE")
    expect(summary.sections[0]!.body).not.toMatch(/WARNING: live feed/)
  })

  it("disconnected: metrics flip, headline is tagged, and the warning LEADS the briefing", () => {
    // This is the replacement for the deleted wall-clock staleness banner and it
    // is the character's only signal that its worldview is frozen rather than
    // merely quiet. It must be the FIRST thing in the briefing body.
    const summary = spaceMoltSituationClassifier.summarize(makeState({ connected: false }))
    expect(summary.metrics.connected).toBe(false)
    expect(summary.headline).toContain("[OFFLINE]")
    expect(summary.sections[0]!.body).toMatch(/^WARNING: live feed disconnected, reconnecting…/)
    expect(summary.sections[0]!.body).toContain("treat the state below as FROZEN")
  })

  it("keeps the section id `briefing` in both states — it is the only prose cognition reads", () => {
    // brain/stem/state.ts's ground-truth correction keys on this id
    // (state.test.ts:573,674). Renaming it silently blinds D3.
    expect(spaceMoltSituationClassifier.summarize(makeState({ connected: true })).sections[0]!.id).toBe("briefing")
    expect(spaceMoltSituationClassifier.summarize(makeState({ connected: false })).sections[0]!.id).toBe("briefing")
  })

  it("no longer reports a wall-clock age — there is no poll to be stale relative to", () => {
    const summary = spaceMoltSituationClassifier.summarize(makeState())
    expect(summary.metrics.stateAgeSec).toBeUndefined()
    expect(summary.metrics.stale).toBeUndefined()
  })
})

describe("situation — structured location metrics (D3 ground truth)", () => {
  it("undocked in space: system/location from state, docked=false, no dockedAt", () => {
    const summary = spaceMoltSituationClassifier.summarize(
      makeState({
        system: { id: "sysA", name: "Horizon", description: "", empire: "Federation", police_level: 3, connections: [], pois: [] },
        poi: { id: "poiX", system_id: "sysA", type: "asteroid_belt", name: "Rubble Field", description: "", position: { x: 0, y: 0 }, resources: [], base_id: null },
      }),
    )
    expect(summary.metrics.system).toBe("Horizon")
    expect(summary.metrics.location).toBe("Rubble Field")
    expect(summary.metrics.docked).toBe(false)
    expect(summary.metrics.dockedAt).toBeUndefined()
  })

  it("docked at a station: docked=true and dockedAt carries the base id", () => {
    const summary = spaceMoltSituationClassifier.summarize(
      makeState({
        player: {
          username: "Pilot",
          credits: 100,
          current_poi: "poiA",
          current_system: "sysA",
          docked_at_base: "baseA",
        } as unknown as GameState["player"],
        ship: {
          hull: 80,
          max_hull: 100,
          fuel: 25,
          max_fuel: 50,
          cargo_used: 3,
          cargo_capacity: 10,
          cargo: [],
          modules: [],
        } as unknown as GameState["ship"],
        system: { id: "sysA", name: "First Step", description: "", empire: "Federation", police_level: 3, connections: [], pois: [] },
        poi: { id: "poiA", system_id: "sysA", type: "station", name: "First Step Memorial Station", description: "", position: { x: 0, y: 0 }, resources: [], base_id: "baseA" },
      }),
    )
    expect(summary.metrics.system).toBe("First Step")
    expect(summary.metrics.location).toBe("First Step Memorial Station")
    expect(summary.metrics.docked).toBe(true)
    expect(summary.metrics.dockedAt).toBe("baseA")
  })

  it("falls back to player.current_system/current_poi when system/poi objects are absent", () => {
    const summary = spaceMoltSituationClassifier.summarize(makeState())
    expect(summary.metrics.system).toBe("sysA")
    expect(summary.metrics.location).toBe("poiA")
    expect(summary.metrics.docked).toBe(false)
  })
})
