import { SituationType } from "./types.js";
import type { GameState, Situation, CargoItem, SystemState } from "./types.js";

/**
 * Generates a concise natural language briefing from game state.
 * Every word earns its place — this is what the agent sees instead of JSON walls.
 */
export function generateBriefing(state: GameState, situation: Situation): string {
	switch (situation.type) {
		case SituationType.Docked:
			return generateDockedBriefing(state);
		case SituationType.InSpace:
			return generateInSpaceBriefing(state, situation);
		case SituationType.InCombat:
			return generateInCombatBriefing(state);
	}
}

function generateDockedBriefing(state: GameState): string {
	const { player, ship, poi, system } = state;
	const lines: string[] = [];

	lines.push(
		`You are docked at ${poi?.name ?? "a station"} in the ${system?.name ?? player.current_system} system (${system?.empire ?? "unknown"} space, police: ${system?.police_level ?? "?"}).`,
	);
	lines.push(resourceLine(player, ship));
	lines.push(shipLoadoutLine(ship));
	lines.push(cargoLine(state.cargo, ship));

	// Nearby ships
	if (state.nearby.length > 0) {
		const names = state.nearby
			.slice(0, 5)
			.map(
				(p) =>
					`${p.username}${p.ship_class ? ` (${p.ship_class.replace(/_/g, " ")})` : ""}`,
			)
			.join(", ");
		const extra = state.nearby.length > 5 ? ` and ${state.nearby.length - 5} more` : "";
		lines.push("");
		lines.push(`Ships nearby: ${names}${extra}.`);
	}

	if (system) {
		lines.push("");
		lines.push(systemPoiSection(system));
	}

	return lines.join("\n");
}

function generateInSpaceBriefing(state: GameState, situation: Situation): string {
	const { player, ship, poi, system, nearby } = state;
	const lines: string[] = [];

	const poiDesc = poi ? `${poi.name} (${poi.type.replace(/_/g, " ")})` : player.current_poi;
	lines.push(
		`You are at ${poiDesc} in the ${system?.name ?? player.current_system} system (${system?.empire ?? "unknown"} space, police: ${system?.police_level ?? "?"}).`,
	);
	lines.push(resourceLine(player, ship));
	lines.push(cargoLine(state.cargo, ship));

	// Resources at mineable POIs
	if (situation.flags.atMineablePoi && poi?.resources?.length) {
		const resources = poi.resources
			.map((r) => `${r.resource_id.replace(/_/g, " ")} (richness: ${r.richness})`)
			.join(", ");
		lines.push(`Mineable resources: ${resources}.`);
	}

	// Nearby players
	if (nearby.length > 0) {
		const names = nearby
			.slice(0, 5)
			.map((p) => p.username)
			.join(", ");
		const extra = nearby.length > 5 ? ` and ${nearby.length - 5} more` : "";
		lines.push(`Nearby: ${names}${extra}.`);
	}

	if (system) {
		lines.push("");
		lines.push(systemPoiSection(system));
	}

	return lines.join("\n");
}

function generateInCombatBriefing(state: GameState): string {
	const { player, ship, poi, nearby } = state;
	const lines: string[] = [];

	lines.push(`COMBAT at ${poi?.name ?? player.current_poi}!`);
	lines.push(`Hull: ${ship.hull}/${ship.max_hull}. Shield: ${ship.shield}/${ship.max_shield}.`);
	lines.push(`Fuel: ${ship.fuel}/${ship.max_fuel}.`);

	if (nearby.length > 0) {
		const hostiles = nearby.filter((p) => p.in_combat);
		const others = nearby.filter((p) => !p.in_combat);
		if (hostiles.length > 0) {
			lines.push(`Hostiles: ${hostiles.map((p) => p.username).join(", ")}.`);
		}
		if (others.length > 0) {
			lines.push(`Others nearby: ${others.map((p) => p.username).join(", ")}.`);
		}
	}

	return lines.join("\n");
}

function resourceLine(player: GameState["player"], ship: GameState["ship"]): string {
	return `Credits: ${player.credits.toLocaleString()}. Fuel: ${ship.fuel}/${ship.max_fuel}. Hull: ${ship.hull}/${ship.max_hull}.`;
}

function shipLoadoutLine(ship: GameState["ship"]): string {
	const modules =
		ship.modules.length > 0 ? ship.modules.map((m) => m.replace(/_/g, " ")).join(", ") : "none";
	return `Ship [${ship.class_id}] "${ship.name}": modules: ${modules}. CPU: ${ship.cpu_used}/${ship.cpu_capacity}. Power: ${ship.power_used}/${ship.power_capacity}. Slots: ${ship.weapon_slots}W/${ship.defense_slots}D/${ship.utility_slots}U.`;
}

function cargoLine(cargo: CargoItem[], ship: GameState["ship"]): string {
	if (cargo.length === 0) {
		return `Cargo: empty (0/${ship.cargo_capacity}).`;
	}
	const summary = compressCargo(cargo);
	return `Cargo: ${ship.cargo_used}/${ship.cargo_capacity} (${summary}).`;
}

function compressCargo(cargo: CargoItem[]): string {
	const sorted = [...cargo].sort((a, b) => b.quantity - a.quantity);
	if (sorted.length <= 5) {
		return sorted.map(formatCargoItem).join(", ");
	}
	const top = sorted.slice(0, 3).map(formatCargoItem).join(", ");
	return `${top}, and ${sorted.length - 3} more types`;
}

function formatCargoItem(item: CargoItem): string {
	const name = item.item_id.replace(/_/g, " ");
	return `${name} [${item.item_id}] x${item.quantity}`;
}

function systemPoiSection(system: SystemState): string {
	// Defensive: SystemState declares connections as a non-optional array, but
	// the in-SPACE get_state snapshot can leave it unpopulated while `system`
	// itself is still truthy. Never assume it's iterable.
	const conns = Array.isArray(system.connections) ? system.connections : [];

	const connections = conns.map((conn) => {
		const label = conn.name ?? conn.system_id;
		return `${label} [${conn.system_id}]`;
	});
	return `Connected systems: ${connections.join(", ") || "none"}. Use find_route to plan multi-jump routes.`;
}

