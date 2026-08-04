/**
 * The one place `@spacemolt/lib`'s state shape and the domain's meet.
 *
 * Replaces `getStateToSnapshot` (the dead `event-processor.ts:139-210`), which
 * did the same job for the `get_state` poll's payload. The library's cache is
 * eight independent sections (`STATE_SECTIONS`, `protocol.ts:184`) seeded from
 * `get_status` and kept current by the deltas riding on `action_result`; the
 * domain's `GameState` is one flat object with location folded onto the
 * player. This module is the fold, and it is PURE — no Effect, no IO, no
 * `Date.now()` — so it is unit-testable against a captured real snapshot.
 *
 * OBSERVED LIVE (2026-08-02, production, character `vcarl`), and the reason
 * several fields are read the way they are:
 *   - all 8 sections seed immediately on login; none are empty or absent;
 *   - `player` carries NO `current_system`/`current_poi`/`docked_at_base` —
 *     those are `location.system_id` / `location.poi_id` / `location.docked_at`;
 *   - `ship` carries NEITHER `fuel_per_jump` NOR `mass`. Any fuel-range
 *     computation must re-query (ship-class catalog / find_route), never read a
 *     ship stat;
 *   - `skills` values are objects (`category`/`level`/`max_level`/`name`/
 *     `next_level_xp`/`xp`), not bare numbers;
 *   - `location.resources` was an EMPTY array live (the character was docked at
 *     a station POI, which has none) — the populated shape
 *     (`item_id`/`item_name`/`remaining`/`richness`/`supported_power`) is
 *     confirmed from the generated OpenAPI type
 *     (`generated/openapi/types.gen.d.ts:6698-6708`), not directly observed
 *     with real values;
 *   - `ship.custom_name` was ABSENT live (this ship was never renamed), so the
 *     custom-name-preferred-over-class-name branch below is exercised by the
 *     generated type's optionality, not by a live example with both present.
 *
 * DELIBERATELY NOT TRANSLATED: `nearby`. The library patches
 * `location.nearby_players` from the observation feed's own cache
 * (`bridgeObservationToLocation`, `account.ts:787-795`), so folding it back
 * here would be circular — and it would silently swap roci's username-fallback
 * departure sweep (`event-processor.ts:232-245`) for `ObservationCache`'s
 * drop-unkeyed-at-ingest behavior. The observation feed owns `nearby`.
 *
 * Also not translated: `missions` and `queue`. Neither has a home ANYWHERE in
 * the domain any more — `GameState` (`types.ts`) has no `missions` /
 * `activeMissions` field at all, `briefing.ts` renders no mission content, and
 * `initialGameState()` populates neither. Mission data is invisible to this
 * read path BY CONSTRUCTION, not merely absent from this translator; carrying
 * it is a task of its own (see the poll-suppression note in
 * `account-socket.ts`, which states the same thing). This translator's scope
 * is the player+ship+location fold only.
 */

import type { GameState as LibGameState } from "@spacemolt/lib";
import type {
	CargoItem,
	PlayerState,
	PoiResource,
	PoiState,
	ShipState,
	SystemConnection,
	SystemState,
} from "./types.js";

/**
 * A normalized partial player+ship snapshot. Fields are partial so a snapshot
 * only overwrites what it actually carries — a sparse section can never zero
 * out state it omits. `applyFullState` (event-processor.ts) is the single
 * codepath that folds one of these onto the prior `GameState`.
 */
export interface FullStateSnapshot {
	player: Partial<PlayerState>;
	ship: Partial<ShipState>;
	/** Full replacement cargo list. `undefined` = leave prior cargo untouched. */
	cargo?: CargoItem[];
	/** `undefined` = leave prior; `null` = clear; object = merge/replace by id. */
	system?: SystemState | null;
	poi?: PoiState | null;
}

/** Ship fields that are plain numbers in both shapes and copy across verbatim. */
const SHIP_NUMBER_KEYS = [
	"hull",
	"max_hull",
	"shield",
	"max_shield",
	"shield_recharge",
	"armor",
	"speed",
	"fuel",
	"max_fuel",
	"cargo_used",
	"cargo_capacity",
	"cpu_used",
	"cpu_capacity",
	"power_used",
	"power_capacity",
	"weapon_slots",
	"defense_slots",
	"utility_slots",
	"damage_penalty",
	"speed_penalty",
	"disruption_ticks_remaining",
] as const;

/**
 * A stable identity for "where the player physically is", for change detection.
 *
 * THIS IS THE LIVE-BUG GUARD. `onStateChange(['location'])` fires for TWO
 * completely different reasons: a real move, and `subscribeObservation()`'s
 * presence bridge patching `nearby_players`/`nearby_player_count` into the same
 * section. In the 2026-08-02 live probe, **8 of 9 non-seed firings were
 * bridge-only** — so anything reacting to "location changed" by trusting
 * section-name membership will fire on almost every observation push and
 * mistake a passing pilot for the player having moved. Diff THIS instead.
 */
export function locationIdentity(cache: Readonly<LibGameState>): string {
	const loc = cache.location;
	return `${loc?.system_id ?? ""}|${loc?.poi_id ?? ""}|${loc?.docked_at ?? ""}`;
}

export function libStateToSnapshot(cache: Readonly<LibGameState>): FullStateSnapshot {
	const player: Partial<PlayerState> = {};
	const p = cache.player;
	if (p) {
		if (p.id != null) player.id = p.id;
		if (p.username != null) player.username = p.username;
		if (p.empire != null) player.empire = p.empire;
		if (p.credits != null) player.credits = p.credits;
		if (p.clan_tag != null) player.clan_tag = p.clan_tag;
		if (p.faction_id !== undefined) player.faction_id = p.faction_id ?? null;
		if (p.faction_rank !== undefined) player.faction_rank = p.faction_rank ?? null;
		if (p.is_cloaked != null) player.is_cloaked = p.is_cloaked;
		if (p.status_message != null) player.status_message = p.status_message;
		if (p.home_base != null) player.home_base = p.home_base;
		if (p.primary_color != null) player.primary_color = p.primary_color;
		if (p.secondary_color != null) player.secondary_color = p.secondary_color;
		if (p.stats != null) player.stats = p.stats as Record<string, number>;
	}

	// The structural difference: location lives in its own section server-side and
	// on the player in this domain. Set `docked_at_base` EXPLICITLY including null
	// whenever `location` is present, so undocking is reflected rather than left
	// stale at the last docked base.
	const loc = cache.location;
	if (loc) {
		if (loc.system_id != null) player.current_system = loc.system_id;
		if (loc.poi_id != null) player.current_poi = loc.poi_id;
		player.docked_at_base = loc.docked_at ?? null;
	}

	// Skills are objects server-side (level/xp/max_level/…), two flat maps here.
	if (cache.skills) {
		const skills: Record<string, number> = {};
		const skillXp: Record<string, number> = {};
		for (const [name, entry] of Object.entries(cache.skills)) {
			if (typeof entry?.level === "number") skills[name] = entry.level;
			if (typeof entry?.xp === "number") skillXp[name] = entry.xp;
		}
		if (Object.keys(skills).length > 0) player.skills = skills;
		if (Object.keys(skillXp).length > 0) player.skill_xp = skillXp;
	}

	const ship: Partial<ShipState> = {};
	const sh = cache.ship;
	if (sh) {
		for (const k of SHIP_NUMBER_KEYS) {
			const v = (sh as Record<string, unknown>)[k];
			if (typeof v === "number") (ship as Record<string, unknown>)[k] = v;
		}
		if (sh.id != null) ship.id = sh.id;
		if (sh.class_id != null) ship.class_id = sh.class_id;
		// `name` is the ship-class display name; `custom_name` is the pilot's own.
		// The domain's `name` is what the briefing prints, so prefer the custom one.
		const shipName = (sh as { custom_name?: string }).custom_name ?? sh.name;
		if (shipName != null) ship.name = shipName;
	}
	// Modules are a separate section server-side and a string list on the domain's
	// ShipState (briefing.ts:247-251 prints them). Prefer the display name.
	if (Array.isArray(cache.modules)) {
		ship.modules = cache.modules
			.map((m) => m.name ?? m.module_id ?? m.type_id ?? "")
			.filter((s) => s.length > 0);
	}

	const cargo: CargoItem[] | undefined = Array.isArray(cache.cargo)
		? cache.cargo.map((c) => ({
				item_id: String(c.item_id ?? ""),
				quantity: Number(c.quantity ?? 0),
			}))
		: undefined;
	if (cargo) ship.cargo = cargo;

	// Minimal located objects. `undefined` leaves the prior object untouched;
	// an explicit `null` poi means "in open space, not at a POI".
	let system: SystemState | null | undefined;
	let poi: PoiState | null | undefined;
	if (loc) {
		system =
			loc.system_id != null
				? ({
						id: loc.system_id,
						name: loc.system_name ?? loc.system_id,
						description: "",
						empire: loc.empire ?? "",
						police_level: 0,
						security_status: loc.security_status,
						connections: (loc.connections ?? []).map(
							(id): SystemConnection => ({ system_id: id, name: id }),
						),
					} satisfies SystemState)
				: undefined;
		poi =
			loc.poi_id != null
				? ({
						id: loc.poi_id,
						system_id: loc.system_id ?? "",
						type: loc.poi_type ?? "",
						name: loc.poi_name ?? loc.poi_id,
						description: "",
						position: { x: 0, y: 0 },
						resources: (loc.resources ?? []).map(
							(r): PoiResource => ({
								resource_id: String(r.item_id ?? ""),
								name: r.item_name,
								richness: String(r.richness ?? ""),
								remaining: Number(r.remaining ?? 0),
							}),
						),
						base_id: loc.docked_at ?? null,
					} satisfies PoiState)
				: null;
	}

	return { player, ship, cargo, system, poi };
}
