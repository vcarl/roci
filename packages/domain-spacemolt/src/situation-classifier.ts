import { SituationType } from "./types.js";
import type { GameState, Situation, SituationFlags } from "./types.js";

const MINEABLE_POI_TYPES = new Set(["asteroid_belt", "ice_field", "gas_cloud"]);
/** Fuel ratio below which the `lowFuel` flag fires. Also the digest's fuel LOW band. */
export const LOW_FUEL_THRESHOLD = 0.25;
const CARGO_NEARLY_FULL_THRESHOLD = 0.9;
/** Hull ratio below which the `lowHull` flag fires. Also the digest's hull LOW band. */
export const LOW_HULL_THRESHOLD = 0.5;
/**
 * Hull ratio below which hull is CRITICAL — mirrors the `hull_critical`
 * interrupt rule (interrupts.ts, priority "critical", `pct < 0.2`). Reused by the
 * status digest so its CRITICAL band matches the amygdala's critical trigger.
 * (Fuel has no critical band: the domain's lowest fuel concern, `fuel_low`, is a
 * "high"-priority interrupt, never "critical" — so the digest bands fuel to LOW only.)
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
	if (state.inCombat) return SituationType.InCombat;
	if (state.travelProgress) return SituationType.InTransit;
	if (state.player.docked_at_base) return SituationType.Docked;
	return SituationType.InSpace;
}

function deriveFlags(state: GameState): SituationFlags {
	const { ship, poi, notifications } = state;

	const fuelRatio = ship.max_fuel > 0 ? ship.fuel / ship.max_fuel : 1;
	const cargoRatio = ship.cargo_capacity > 0 ? ship.cargo_used / ship.cargo_capacity : 0;
	const hullRatio = ship.max_hull > 0 ? ship.hull / ship.max_hull : 1;

	return {
		atMineablePoi: poi != null && MINEABLE_POI_TYPES.has(poi.type),
		atDockablePoi: poi?.base_id != null,
		lowFuel: fuelRatio < LOW_FUEL_THRESHOLD,
		cargoNearlyFull: cargoRatio > CARGO_NEARLY_FULL_THRESHOLD,
		cargoFull: ship.cargo_used >= ship.cargo_capacity,
		lowHull: hullRatio < LOW_HULL_THRESHOLD,
		hasPendingTrades: (state.pendingTrades ?? []).length > 0,
		hasUnreadChat: notifications.some(
			(n) => n.msg_type === "chat_message" || n.type === "chat_message",
		),
		hasCompletableMission: (state.activeMissions ?? []).some(
			(m) => m.status === "completed" || m.status === "ready",
		),
	};
}
