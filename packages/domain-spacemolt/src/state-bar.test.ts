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
    notifications: [],
    travelProgress: null,
    inCombat: false,
    tick: 512,
    timestamp: Date.now(),
    lastFullStateAt: Date.now(),
    ...overrides,
  }
}

describe("state bar — staleness instrumentation", () => {
  it("formatStateBar renders the current tick and full-state age", () => {
    const bar = spaceMoltStateRenderer.formatStateBar({
      situationType: "in_space",
      fuel: 0.5,
      hull: 0.8,
      cargoUsed: 3,
      cargoCapacity: 10,
      inCombat: false,
      tick: 512,
      stateAgeSec: 42,
    })
    expect(bar).toContain("t:512")
    expect(bar).toContain("age:42s")
  })

  it("summarize surfaces tick + a non-negative stateAgeSec in metrics", () => {
    const summary = spaceMoltSituationClassifier.summarize(
      makeState({ tick: 777, lastFullStateAt: Date.now() - 30_000 }),
    )
    expect(summary.metrics.tick).toBe(777)
    expect(typeof summary.metrics.stateAgeSec).toBe("number")
    expect(summary.metrics.stateAgeSec as number).toBeGreaterThanOrEqual(29)
    // and those metrics render into the bar
    const bar = spaceMoltStateRenderer.formatStateBar(summary.metrics)
    expect(bar).toContain("t:777")
    expect(bar).toMatch(/age:\d+s/)
  })

  it("age falls back to timestamp when lastFullStateAt is absent (legacy state)", () => {
    const state = makeState({ timestamp: Date.now() - 10_000 })
    delete (state as { lastFullStateAt?: number }).lastFullStateAt
    const summary = spaceMoltSituationClassifier.summarize(state)
    expect(summary.metrics.stateAgeSec as number).toBeGreaterThanOrEqual(9)
  })
})

describe("situation — staleness stamp (disconnected live feed)", () => {
  it("fresh state: stale=false, no warning, plain headline", () => {
    const summary = spaceMoltSituationClassifier.summarize(
      makeState({ lastFullStateAt: Date.now() - 5_000 }),
    )
    expect(summary.metrics.stale).toBe(false)
    expect(summary.headline).not.toContain("STALE")
    expect(summary.sections[0]!.body).not.toMatch(/WARNING: live feed/)
  })

  it("state older than ~2 refresh intervals: stale=true, loud warning + headline tag", () => {
    // 120s > 90s STATE_STALE_WARN_MS threshold.
    const summary = spaceMoltSituationClassifier.summarize(
      makeState({ lastFullStateAt: Date.now() - 120_000 }),
    )
    expect(summary.metrics.stale).toBe(true)
    expect(summary.metrics.stateAgeSec as number).toBeGreaterThanOrEqual(119)
    expect(summary.headline).toMatch(/\[STALE \d+s\]/)
    // Warning is the FIRST thing cognition reads in the briefing body.
    expect(summary.sections[0]!.body).toMatch(/^WARNING: live feed disconnected, data is \d+s old, reconnecting…/)
    expect(summary.sections[0]!.body).toContain("treat the state below as FROZEN")
  })

  it("just under the threshold stays fresh (boundary)", () => {
    const summary = spaceMoltSituationClassifier.summarize(
      makeState({ lastFullStateAt: Date.now() - 80_000 }),
    )
    expect(summary.metrics.stale).toBe(false)
    expect(summary.headline).not.toContain("STALE")
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
