import { SituationType } from "../types.js";
import type { Alert, GameState, Situation } from "../types.js";

/**
 * Detects priority conditions from game state and situation.
 * Returns alerts ordered by priority (critical first).
 */
export function detectAlerts(state: GameState, situation: Situation): Alert[] {
	const alerts: Alert[] = [];
	const { ship } = state;
	const { type, flags } = situation;

	// Critical alerts
	if (type === SituationType.InCombat) {
		alerts.push({
			priority: "critical",
			message: "You are in combat! Focus on fighting or flee.",
			suggestedAction: "attack",
		});
	}

	const hullPct = ship.max_hull > 0 ? Math.round((ship.hull / ship.max_hull) * 100) : 100;
	if (hullPct < 20) {
		alerts.push({
			priority: "critical",
			message: `Hull critically damaged (${hullPct}%). Repair immediately or retreat.`,
			suggestedAction: type === SituationType.Docked ? "repair" : "dock",
		});
	}

	// High alerts
	const fuelPct = ship.max_fuel > 0 ? Math.round((ship.fuel / ship.max_fuel) * 100) : 100;
	if (flags.lowFuel && type !== SituationType.Docked) {
		alerts.push({
			priority: "high",
			message: `Fuel low (${fuelPct}%). Find a station to refuel before you're stranded.`,
			suggestedAction: "find_route",
		});
	}

	if (flags.lowHull && type !== SituationType.Docked && hullPct >= 20) {
		alerts.push({
			priority: "high",
			message: `Hull damaged (${hullPct}%). Consider docking for repairs.`,
			suggestedAction: "dock",
		});
	}

	// Medium alerts
	if (flags.cargoFull) {
		alerts.push({
			priority: "medium",
			message: "Cargo hold is full. Sell or deposit items before mining more.",
			suggestedAction: type === SituationType.Docked ? "market_sell" : "dock",
		});
	}

	if (flags.hasPendingTrades) {
		alerts.push({
			priority: "medium",
			message: "You have pending trade offers to review.",
			suggestedAction: "get_trades",
		});
	}

	if (flags.hasCompletableMission) {
		alerts.push({
			priority: "medium",
			message: "A mission is ready to complete!",
			suggestedAction: "complete_mission",
		});
	}

	// Low alerts
	if (flags.cargoNearlyFull && !flags.cargoFull) {
		const cargoPct = Math.round((ship.cargo_used / ship.cargo_capacity) * 100);
		alerts.push({
			priority: "low",
			message: `Cargo nearly full (${cargoPct}%). Plan to offload soon.`,
		});
	}

	if (flags.hasUnreadChat) {
		alerts.push({
			priority: "low",
			message: "New chat messages received.",
			suggestedAction: "get_chat_history",
		});
	}

	if (flags.lowFuel && type === SituationType.Docked) {
		alerts.push({
			priority: "low",
			message: `Fuel low (${fuelPct}%). Refuel before undocking.`,
			suggestedAction: "refuel",
		});
	}

	return alerts;
}
