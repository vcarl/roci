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
