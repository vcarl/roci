import { describe, it, expect } from "vitest"
import type { GameState, NearbyPlayer } from "./types.js"
import {
	buildStatusDigest,
	formatEventDigest,
	isSnapshotEventType,
	NEARBY_DIGEST_CAP,
} from "./event-digest.js"

/** Minimal GameState with a healthy, full ship — override per case. */
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
			hull: 100,
			max_hull: 100,
			fuel: 100,
			max_fuel: 100,
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

function nearby(username: string): NearbyPlayer {
	return {
		player_id: username,
		username,
		ship_class: "cobble",
		faction_id: null,
		faction_tag: null,
		status_message: "",
		clan_tag: "",
		primary_color: "",
		secondary_color: "",
		anonymous: false,
		in_combat: false,
	}
}

describe("buildStatusDigest", () => {
	it("bands low fuel and surfaces the percentage", () => {
		const d = buildStatusDigest(
			makeState({ ship: { fuel: 6, max_fuel: 100, hull: 100, max_hull: 100 } as unknown as GameState["ship"] }),
		)
		expect(d).toContain("fuel 6% (LOW)")
		expect(d).toContain("hull 100%")
		expect(d).not.toContain("hull 100% (")
	})

	it("marks full fuel and full hull with no band", () => {
		const d = buildStatusDigest(makeState())
		expect(d).toContain("fuel 100%")
		expect(d).toContain("hull 100%")
		expect(d).not.toContain("(LOW)")
		expect(d).not.toContain("(CRITICAL)")
	})

	it("bands hull CRITICAL below 20% and LOW below 50%", () => {
		const crit = buildStatusDigest(
			makeState({ ship: { fuel: 100, max_fuel: 100, hull: 15, max_hull: 100 } as unknown as GameState["ship"] }),
		)
		expect(crit).toContain("hull 15% (CRITICAL)")
		const low = buildStatusDigest(
			makeState({ ship: { fuel: 100, max_fuel: 100, hull: 40, max_hull: 100 } as unknown as GameState["ship"] }),
		)
		expect(low).toContain("hull 40% (LOW)")
	})

	it("renders a docked location with the base id and human name", () => {
		const d = buildStatusDigest(
			makeState({
				player: {
					current_poi: "first_step_memorial_station",
					current_system: "first_step",
					docked_at_base: "first_step_memorial_station",
				} as unknown as GameState["player"],
				poi: { id: "first_step_memorial_station", name: "First Step Memorial Station" } as unknown as GameState["poi"],
			}),
		)
		expect(d).toContain("docked at first_step_memorial_station (First Step Memorial Station)")
	})

	it("renders an undocked location as `at <poi> in <system>`", () => {
		const d = buildStatusDigest(
			makeState({
				player: {
					current_poi: "belt_a",
					current_system: "markeb",
					docked_at_base: null,
				} as unknown as GameState["player"],
				poi: { id: "belt_a", name: "Markeb Belt" } as unknown as GameState["poi"],
				system: { id: "markeb", name: "Markeb" } as unknown as GameState["system"],
			}),
		)
		expect(d).toContain("at Markeb Belt in Markeb")
		expect(d).not.toContain("docked")
	})

	it("truncates the nearby list to the cap and reports the overflow count", () => {
		const names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf"]
		const d = buildStatusDigest(makeState({ nearby: names.map(nearby) }))
		expect(d).toContain("7 pilots nearby")
		for (const n of names.slice(0, NEARBY_DIGEST_CAP)) expect(d).toContain(n)
		expect(d).toContain(`+${names.length - NEARBY_DIGEST_CAP} more`)
		// Names beyond the cap are not listed.
		expect(d).not.toContain("Foxtrot")
		expect(d).not.toContain("Golf")
	})

	it("omits the nearby clause when no pilots are present", () => {
		const d = buildStatusDigest(makeState({ nearby: [] }))
		expect(d).not.toContain("nearby")
	})

	it("is deterministic for identical state", () => {
		const s = makeState({
			ship: { fuel: 42, max_fuel: 100, hull: 90, max_hull: 100 } as unknown as GameState["ship"],
			nearby: [nearby("Alpha"), nearby("Bravo")],
		})
		expect(buildStatusDigest(s)).toBe(buildStatusDigest(s))
	})
})

describe("formatEventDigest gating", () => {
	it("returns a digest only for snapshot event types", () => {
		const s = makeState()
		expect(formatEventDigest("full_state", s)).toContain("STATUS:")
		expect(formatEventDigest("logged_in", s)).toContain("STATUS:")
		expect(formatEventDigest("observation_update", s)).toContain("STATUS:")
	})

	it("appends `; no alerts` to band-less full_state/logged_in digests only", () => {
		const healthy = makeState()
		expect(formatEventDigest("full_state", healthy)).toMatch(/; no alerts$/)
		expect(formatEventDigest("logged_in", healthy)).toMatch(/; no alerts$/)
		// observation_update never carries the marker — its news is the delta.
		expect(formatEventDigest("observation_update", healthy)).not.toContain("no alerts")
		// A banded frame ends with an explicit ALERT token instead.
		const lowFuel = makeState({
			ship: { fuel: 6, max_fuel: 100, hull: 100, max_hull: 100 } as unknown as GameState["ship"],
		})
		expect(formatEventDigest("full_state", lowFuel)).toContain("(LOW)")
		expect(formatEventDigest("full_state", lowFuel)).toMatch(/; ALERT: fuel low$/)
		expect(formatEventDigest("full_state", lowFuel)).not.toContain("no alerts")
		const critHull = makeState({
			ship: { fuel: 100, max_fuel: 100, hull: 15, max_hull: 100 } as unknown as GameState["ship"],
		})
		expect(formatEventDigest("full_state", critHull)).toMatch(/; ALERT: hull critical$/)
	})

	it("returns empty string for chat and discrete events", () => {
		const s = makeState()
		expect(formatEventDigest("chat", s)).toBe("")
		expect(formatEventDigest("chat_message", s)).toBe("")
		expect(formatEventDigest("market_update", s)).toBe("")
		expect(formatEventDigest("combat", s)).toBe("")
	})

	it("isSnapshotEventType matches the snapshot frame types", () => {
		expect(isSnapshotEventType("full_state")).toBe(true)
		expect(isSnapshotEventType("logged_in")).toBe(true)
		expect(isSnapshotEventType("observation_update")).toBe(true)
		expect(isSnapshotEventType("chat")).toBe(false)
		expect(isSnapshotEventType("market_update")).toBe(false)
	})
})
