import { SituationType } from "./types.js";
import type { GameState, Situation, SituationFlags } from "./types.js";

const MINEABLE_POI_TYPES = new Set(["asteroid_belt", "ice_field", "gas_cloud"]);
/**
 * Fuel ratio below which `event-digest.ts` stamps the status line's fuel LOW
 * band. The `lowFuel` situation flag this constant used to gate was deleted
 * with the severity system; this threshold survived because the digest is a
 * real consumer.
 */
export const LOW_FUEL_THRESHOLD = 0.25;
/**
 * Hull ratio below which `event-digest.ts` stamps the status line's hull LOW
 * band. The `lowHull` situation flag this constant used to gate was deleted
 * with the severity system; this threshold survived because the digest is a
 * real consumer.
 */
export const LOW_HULL_THRESHOLD = 0.5;
/**
 * Hull ratio below which hull is CRITICAL — the band below which the digest
 * stamps `(CRITICAL)` and emits `; ALERT: hull critical`. Reused by the
 * status digest so its CRITICAL band matches the amygdala's critical trigger.
 * (Fuel has no critical band — the digest bands fuel to LOW only.)
 */
export const HULL_CRITICAL_THRESHOLD = 0.2;

/**
 * Classifies the current game state into a situation type and flags.
 * Pure function — no side effects, no API calls.
 */
export function classifySituation(state: GameState): Situation {
	const type = classifyType(state);
	const flags = deriveFlags(state);
	return { type, flags };
}

function classifyType(state: GameState): SituationType {
	// The InTransit branch is gone with `travelProgress`, whose only writer
	// always wrote null — the situation was unreachable for the whole life of
	// the domain. The library's `location.in_transit` could resurrect it
	// properly one day; that is a feature, not a restoration, and is out of
	// scope here.
	if (state.inCombat) return SituationType.InCombat;
	if (state.player.docked_at_base) return SituationType.Docked;
	return SituationType.InSpace;
}

function deriveFlags(state: GameState): SituationFlags {
	const { poi } = state;
	return {
		atMineablePoi: poi != null && MINEABLE_POI_TYPES.has(poi.type),
	};
}
