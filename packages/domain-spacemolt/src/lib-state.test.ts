import type { GameState as LibGameState } from "@spacemolt/lib";
import { describe, expect, it } from "vitest";
import { libStateToSnapshot, locationIdentity } from "./lib-state.js";

/**
 * The shape of a real seeded `StateCache`, captured from the production server
 * on 2026-08-02 (character `vcarl`, docked at a station). Values are reduced
 * and de-identified; the KEY SET is the thing under test — every top-level key
 * here, and every key within `player`/`ship`/`location`/`skills`, was observed
 * present on the live login seed. Two things the live capture called out
 * (see `lib-state.ts`'s module doc):
 *   - `location.resources` was an EMPTY array live (a station POI has none);
 *     the populated shape below (`item_id`/`item_name`/`richness`/`remaining`)
 *     is confirmed from the generated OpenAPI type, not a live non-empty read;
 *   - `ship.custom_name` was ABSENT live (this ship was never renamed). It's
 *     included here (optional in the generated type) to pin the
 *     prefer-custom-name-when-present branch; the absent case — what was
 *     actually observed live — has its own test below using a cache without it.
 */
const libCache = (over: Partial<LibGameState> = {}): LibGameState =>
	({
		player: {
			id: "p1",
			username: "Pilot",
			empire: "solarian",
			credits: 4200,
			clan_tag: "",
			faction_id: null,
			faction_rank: null,
			is_cloaked: false,
			status_message: "hi",
			home_base: "first_step_memorial_base",
			home_poi: "first_step_memorial_station",
			home_system: "first_step",
			primary_color: "#FFFFFF",
			secondary_color: "#000000",
			citizenships: ["solarian"],
			standings: {},
			stats: { ore_mined: 12 },
		},
		ship: {
			id: "s1",
			class_id: "prospector",
			class_name: "Prospector",
			name: "Prospector",
			custom_name: "Kestrel",
			hull: 80,
			max_hull: 100,
			shield: 10,
			max_shield: 50,
			shield_recharge: 2,
			armor: 0,
			speed: 4,
			fuel: 6,
			max_fuel: 100,
			cargo_used: 3,
			cargo_capacity: 10,
			cpu_used: 2,
			cpu_capacity: 8,
			power_used: 3,
			power_capacity: 9,
			weapon_slots: 1,
			defense_slots: 1,
			utility_slots: 2,
		},
		modules: [
			{ module_id: "m1", name: "Mining Laser I", type: "mining", type_id: "mining_laser_i" },
			{ module_id: "m2", name: "Shield Booster I", type: "defense", type_id: "shield_booster_i" },
		],
		cargo: [{ item_id: "ore_iron", item_name: "Iron Ore", quantity: 3, size: 1 }],
		location: {
			system_id: "first_step",
			system_name: "First Step",
			poi_id: "first_step_memorial_station",
			poi_name: "First Step Memorial Station",
			poi_type: "station",
			docked_at: "first_step_memorial_base",
			empire: "solarian",
			security_status: "high",
			connections: ["quiet_reach", "long_fall"],
			nearby_players: [{ player_id: "x1", username: "Pilgrim" }],
			nearby_player_count: 1,
			nearby_pirates: [],
			nearby_pirate_count: 0,
			nearby_empire_npcs: [],
			nearby_empire_npc_count: 0,
			offline_collapsed: 0,
			resources: [{ item_id: "ore_iron", item_name: "Iron Ore", richness: 3, remaining: 900 }],
		},
		missions: { active: [], max_missions: 3 },
		queue: { has_pending: false },
		skills: {
			mining: {
				category: "industry",
				level: 4,
				max_level: 10,
				name: "Mining",
				next_level_xp: 500,
				xp: 320,
			},
			trading: {
				category: "economy",
				level: 1,
				max_level: 10,
				name: "Trading",
				next_level_xp: 100,
				xp: 10,
			},
		},
		...over,
	}) as LibGameState;

describe("libStateToSnapshot — the structural fold", () => {
	it("moves location onto the player: system_id/poi_id/docked_at → current_system/current_poi/docked_at_base", () => {
		// OBSERVED LIVE: the library's `player` section carries none of these three.
		// They live in `location`. This fold is the single largest structural
		// difference between the two shapes, and a frozen location bar is what a
		// regression here looks like.
		const s = libStateToSnapshot(libCache());
		expect(s.player.current_system).toBe("first_step");
		expect(s.player.current_poi).toBe("first_step_memorial_station");
		expect(s.player.docked_at_base).toBe("first_step_memorial_base");
	});

	it("sets docked_at_base to null EXPLICITLY when undocked, so undocking is not left stale", () => {
		const c = libCache();
		const s = libStateToSnapshot({
			...c,
			location: { ...c.location, docked_at: null },
		} as LibGameState);
		expect(s.player.docked_at_base).toBeNull();
		expect("docked_at_base" in s.player).toBe(true);
	});

	it("copies the player scalars the briefing and the digest read", () => {
		const s = libStateToSnapshot(libCache());
		expect(s.player.id).toBe("p1");
		expect(s.player.username).toBe("Pilot");
		expect(s.player.empire).toBe("solarian");
		expect(s.player.credits).toBe(4200);
		expect(s.player.faction_id).toBeNull();
	});

	it("flattens the object-valued skills section into level and xp maps", () => {
		// OBSERVED LIVE: skills values are {category, level, max_level, name,
		// next_level_xp, xp} objects, not bare numbers.
		const s = libStateToSnapshot(libCache());
		expect(s.player.skills).toEqual({ mining: 4, trading: 1 });
		expect(s.player.skill_xp).toEqual({ mining: 320, trading: 10 });
	});

	it("copies every ship number the digest bands on", () => {
		const s = libStateToSnapshot(libCache());
		expect(s.ship.fuel).toBe(6);
		expect(s.ship.max_fuel).toBe(100);
		expect(s.ship.hull).toBe(80);
		expect(s.ship.max_hull).toBe(100);
		expect(s.ship.cargo_used).toBe(3);
		expect(s.ship.cargo_capacity).toBe(10);
	});

	it("prefers the pilot's custom ship name over the class display name", () => {
		expect(libStateToSnapshot(libCache()).ship.name).toBe("Kestrel");
	});

	it("falls back to the class display name when custom_name is absent — the case actually observed live", () => {
		// OBSERVED LIVE: the real ship (never renamed) had NO `custom_name` key at
		// all — not `null`, simply absent. This is the common case, not the
		// preference branch above.
		const c = libCache();
		const { custom_name: _drop, ...shipWithoutCustomName } = c.ship as Record<string, unknown>;
		const s = libStateToSnapshot({ ...c, ship: shipWithoutCustomName } as LibGameState);
		expect(s.ship.name).toBe("Prospector");
	});

	it("renders the modules section as the string list the briefing prints", () => {
		expect(libStateToSnapshot(libCache()).ship.modules).toEqual([
			"Mining Laser I",
			"Shield Booster I",
		]);
	});

	it("translates cargo onto both the top-level list and ship.cargo", () => {
		const s = libStateToSnapshot(libCache());
		expect(s.cargo).toEqual([{ item_id: "ore_iron", quantity: 3 }]);
		expect(s.ship.cargo).toEqual([{ item_id: "ore_iron", quantity: 3 }]);
	});

	it("builds a located system with the adjacency list the connections array carries", () => {
		const s = libStateToSnapshot(libCache());
		expect(s.system?.id).toBe("first_step");
		expect(s.system?.name).toBe("First Step");
		expect(s.system?.connections.map((c) => c.system_id)).toEqual(["quiet_reach", "long_fall"]);
	});

	it("builds a located POI, mapping item_id→resource_id and stringifying richness", () => {
		// The domain's PoiResource.richness is a STRING ("rich"/"3"); the library's
		// is a number. briefing.ts:165-169 prints it verbatim.
		const s = libStateToSnapshot(libCache());
		expect(s.poi?.id).toBe("first_step_memorial_station");
		expect(s.poi?.type).toBe("station");
		expect(s.poi?.resources).toEqual([
			{ resource_id: "ore_iron", name: "Iron Ore", richness: "3", remaining: 900 },
		]);
	});

	it("returns an empty resources list when the POI has none — OBSERVED LIVE (a station POI)", () => {
		const c = libCache();
		const s = libStateToSnapshot({
			...c,
			location: { ...c.location, resources: [] },
		} as LibGameState);
		expect(s.poi?.resources).toEqual([]);
	});

	it("returns poi null (not undefined) when the player is in open space", () => {
		const c = libCache();
		const { poi_id: _drop, ...rest } = c.location as Record<string, unknown>;
		const s = libStateToSnapshot({ ...c, location: rest } as LibGameState);
		expect(s.poi).toBeNull();
	});

	it("leaves system and poi UNDEFINED when the location section is absent entirely", () => {
		// undefined means "leave the prior object untouched" in applyFullState — a
		// section-less delta must never clear a location it says nothing about.
		const c = libCache();
		const { location: _drop, ...rest } = c as Record<string, unknown>;
		const s = libStateToSnapshot(rest as LibGameState);
		expect(s.system).toBeUndefined();
		expect(s.poi).toBeUndefined();
		expect(s.player.current_system).toBeUndefined();
	});

	it("never invents fuel_per_jump or mass — CONFIRMED LIVE that ship carries neither", () => {
		const s = libStateToSnapshot(libCache());
		expect("fuel_per_jump" in s.ship).toBe(false);
		expect("mass" in s.ship).toBe(false);
	});

	it("does not translate `nearby` — the observation feed owns that roster", () => {
		expect("nearby" in libStateToSnapshot(libCache())).toBe(false);
	});

	it("survives a completely empty cache without throwing", () => {
		const s = libStateToSnapshot({} as LibGameState);
		expect(s.player).toEqual({});
		expect(s.ship).toEqual({});
		expect(s.cargo).toBeUndefined();
	});
});

describe("locationIdentity — the observation-bridge guard", () => {
	it("is stable across a nearby_players patch that did NOT move the player", () => {
		// THE LIVE BUG THIS EXISTS FOR: `onStateChange(['location'])` fires for
		// subscribeObservation()'s presence bridge as well as for real movement.
		// 8 of 9 non-seed firings in the 2026-08-02 probe were bridge-only.
		const before = libCache();
		const after = libCache({
			location: { ...before.location, nearby_players: [], nearby_player_count: 0 },
		} as Partial<LibGameState>);
		expect(locationIdentity(after)).toBe(locationIdentity(before));
	});

	it("changes when the POI changes", () => {
		const before = libCache();
		const after = libCache({
			location: { ...before.location, poi_id: "quiet_reach_belt", docked_at: null },
		} as Partial<LibGameState>);
		expect(locationIdentity(after)).not.toBe(locationIdentity(before));
	});

	it("changes when only the dock state changes (undocking at the same POI)", () => {
		const before = libCache();
		const after = libCache({
			location: { ...before.location, docked_at: null },
		} as Partial<LibGameState>);
		expect(locationIdentity(after)).not.toBe(locationIdentity(before));
	});

	it("is a stable empty-ish string for an unseeded cache rather than throwing", () => {
		expect(locationIdentity({} as LibGameState)).toBe("||");
	});
});
