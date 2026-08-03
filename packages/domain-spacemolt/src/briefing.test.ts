import { describe, it, expect } from "vitest"
import { generateBriefing } from "./briefing.js"
import { SituationType } from "./types.js"
import type { GameState, Situation, SystemState } from "./types.js"

/** Minimal in-space GameState sufficient for briefing generation. */
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
			modules: [],
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

const inSpaceSituation: Situation = {
	type: SituationType.InSpace,
	flags: {
		atMineablePoi: false,
	},
}

describe("generateBriefing — in-space system POI section", () => {
	it("does not throw and degrades gracefully when system.pois/connections are missing (real get_state shape)", () => {
		// The in-SPACE get_state snapshot leaves connections/pois unpopulated even
		// though SystemState declares them as non-optional arrays. `system` itself
		// is truthy, so the render-site must not assume the arrays are iterable.
		const system = {
			id: "sysA",
			name: "Alpha",
			description: "",
			empire: "Federation",
			police_level: 3,
			// connections/pois intentionally absent — mirrors the real payload.
		} as unknown as SystemState

		const state = makeState({ system })

		expect(() => generateBriefing(state, inSpaceSituation)).not.toThrow()

		const briefing = generateBriefing(state, inSpaceSituation)
		expect(briefing).toContain("System locations:")
		expect(briefing).not.toContain("System locations:\n-")
		expect(briefing).toContain("Connected systems: none. Use find_route to plan multi-jump routes.")
	})

	it("still renders POIs and connections normally when the arrays are present", () => {
		const system: SystemState = {
			id: "sysA",
			name: "Alpha",
			description: "",
			empire: "Federation",
			police_level: 3,
			connections: [{ system_id: "sysB", name: "Beta", distance: 4 }],
			pois: [{ id: "poiX", name: "Outpost X", type: "station", base_id: "baseX" }],
		}

		const state = makeState({ system })
		const briefing = generateBriefing(state, inSpaceSituation)

		expect(briefing).toContain("Outpost X [poiX]");
		expect(briefing).toContain("Connected systems: Beta [sysB] (4 GU).")
	})
})
