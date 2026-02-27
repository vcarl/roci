import { SituationType } from "../types.js";
import type {
	GameState,
	Situation,
	CargoItem,
	Alert,
	MarketItem,
	PlayerOrder,
	StorageItem,
	SystemState,
	GalaxyMap,
	SocialState,
} from "../types.js";

/**
 * Generates a concise natural language briefing from game state.
 * Every word earns its place — this is what the agent sees instead of JSON walls.
 */
export function generateBriefing(
	state: GameState,
	situation: Situation,
	galaxyMap?: GalaxyMap,
): string {
	switch (situation.type) {
		case SituationType.Docked:
			return generateDockedBriefing(state, galaxyMap);
		case SituationType.InSpace:
			return generateInSpaceBriefing(state, situation, galaxyMap);
		case SituationType.InTransit:
			return generateInTransitBriefing(state);
		case SituationType.InCombat:
			return generateInCombatBriefing(state);
	}
}

function generateDockedBriefing(state: GameState, galaxyMap?: GalaxyMap): string {
	const { player, ship, poi, system, market, activeMissions, missions } = state;
	const lines: string[] = [];

	lines.push(
		`You are docked at ${poi?.name ?? "a station"} in the ${system?.name ?? player.current_system} system (${system?.empire ?? "unknown"} space, police: ${system?.police_level ?? "?"}).`,
	);
	lines.push(resourceLine(player, ship));
	lines.push(shipLoadoutLine(ship));
	lines.push(cargoLine(state.cargo, ship));

	// Cargo at market prices
	if (state.cargo.length > 0 && market && market.length > 0) {
		lines.push("");
		lines.push("Your cargo at market prices:");
		for (const item of state.cargo) {
			const name = item.item_id.replace(/_/g, " ");
			const mkt = market.find((m) => m.item_id === item.item_id);
			if (mkt && mkt.best_buy > 0) {
				const total = mkt.best_buy * item.quantity;
				const sellNote = mkt.best_sell > 0 ? ` (cheapest sell: ${mkt.best_sell} cr)` : "";
				lines.push(
					`- ${name} [${item.item_id}] x${item.quantity}: buy orders at ${mkt.best_buy} cr/unit -> ${total.toLocaleString()} cr${sellNote}`,
				);
			} else {
				lines.push(
					`- ${name} [${item.item_id}] x${item.quantity}: no buy orders (use create_sell_order to list)`,
				);
			}
		}
	}

	// Station market overview
	if (market && market.length > 0) {
		const cargoIds = new Set(state.cargo.map((c) => c.item_id));
		const buyable = market
			.filter((m) => !cargoIds.has(m.item_id) && m.best_sell > 0 && m.sell_quantity > 0)
			.sort((a, b) => b.sell_quantity - a.sell_quantity)
			.slice(0, 10);
		if (buyable.length > 0) {
			lines.push("");
			lines.push("Station market (available to buy):");
			for (const m of buyable) {
				const name = (m.item_name || m.item_id).replace(/_/g, " ");
				const buyBack = m.best_buy > 0 ? ` / buy orders at ${m.best_buy} cr` : "";
				lines.push(
					`- ${name} [${m.item_id}]: ${m.best_sell} cr/unit (${m.sell_quantity} available)${buyBack}`,
				);
			}
		}
	}

	// Active orders
	if (state.orders && state.orders.length > 0) {
		lines.push("");
		lines.push(formatOrdersSummary(state.orders));
	}

	// Station storage
	if (state.storage || state.storageCredits) {
		const storageStr = formatStorageSummary(state.storage ?? [], state.storageCredits ?? 0);
		if (storageStr) {
			lines.push("");
			lines.push(storageStr);
		}
	}

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

	// Active missions
	if (activeMissions && activeMissions.length > 0) {
		lines.push("");
		lines.push("Active missions:");
		for (const m of activeMissions) {
			const progress = m.progress ? ` (${m.progress})` : "";
			const tag =
				m.status === "completed" ? " *** READY TO COMPLETE ***" : ` [${m.status}]`;
			lines.push(
				`- ${m.title} [${m.id}]${progress} — reward: ${m.reward_credits.toLocaleString()} cr${tag}`,
			);
		}
		const completable = activeMissions.filter((m) => m.status === "completed");
		if (completable.length > 0) {
			lines.push(
				`Use complete_mission with mission_id to collect rewards (e.g. complete_mission mission_id="${completable[0].id}").`,
			);
		}
	}

	// Available missions
	if (missions && missions.length > 0) {
		lines.push("");
		lines.push("Available missions:");
		const sorted = [...missions].sort((a, b) => b.reward_credits - a.reward_credits);
		for (const m of sorted.slice(0, 5)) {
			const req = m.requirements ? `: ${m.requirements}` : "";
			lines.push(
				`- ${m.title} [${m.id}]${req} — reward: ${m.reward_credits.toLocaleString()} cr`,
			);
		}
		if (sorted.length > 5) {
			lines.push(`  (and ${sorted.length - 5} more)`);
		}
	}

	if (system) {
		lines.push("");
		lines.push(systemPoiSection(system, galaxyMap));
	}

	return lines.join("\n");
}

function generateInSpaceBriefing(
	state: GameState,
	situation: Situation,
	galaxyMap?: GalaxyMap,
): string {
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

	// Active missions
	if (state.activeMissions && state.activeMissions.length > 0) {
		lines.push("");
		lines.push("Active missions:");
		for (const m of state.activeMissions) {
			const progress = m.progress ? ` (${m.progress})` : "";
			const tag = m.status === "completed" ? " *** READY — dock to complete ***" : "";
			lines.push(
				`- ${m.title}${progress} — reward: ${m.reward_credits.toLocaleString()} cr${tag}`,
			);
		}
	}

	if (system) {
		lines.push("");
		lines.push(systemPoiSection(system, galaxyMap));
	}

	return lines.join("\n");
}

function generateInTransitBriefing(state: GameState): string {
	const { player, ship, travelProgress } = state;
	const lines: string[] = [];

	if (travelProgress) {
		const pct = Math.round(travelProgress.travel_progress * 100);
		const type = travelProgress.travel_type === "jump" ? "Jumping" : "Traveling";
		lines.push(`${type} to ${travelProgress.travel_destination} (${pct}% complete).`);
	} else {
		lines.push("In transit.");
	}

	lines.push(resourceLine(player, ship));
	lines.push("Nothing to do until arrival. Plan your next move.");

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

function systemPoiSection(system: SystemState, galaxyMap?: GalaxyMap): string {
	const lines: string[] = [];
	lines.push("System locations:");
	for (const poi of system.pois) {
		const typeName = poi.type.replace(/_/g, " ");
		const dockable = poi.base_id ? " (dockable)" : "";
		let detail = `- ${poi.name} [${poi.id}] — ${typeName}${dockable}`;
		if (poi.resources && poi.resources.length > 0) {
			const res = poi.resources
				.map((r) => `${r.resource_id.replace(/_/g, " ")} ${r.richness}`)
				.join(", ");
			detail += ` — resources: ${res}`;
		}
		lines.push(detail);
	}
	const connections = system.connections.map((conn) => {
		const mapEntry = galaxyMap?.get(conn.system_id);
		const label = mapEntry?.name ?? conn.name ?? conn.system_id;
		const dist = conn.distance ? ` (${conn.distance} GU)` : "";
		return `${label} [${conn.system_id}]${dist}`;
	});
	lines.push(
		`Connected systems: ${connections.join(", ") || "none"}. Use find_route to plan multi-jump routes.`,
	);
	return lines.join("\n");
}

function formatOrdersSummary(orders: PlayerOrder[]): string {
	const lines = ["Your active orders:"];
	for (const o of orders) {
		const name = (o.item_name || o.item_id).replace(/_/g, " ");
		const fillPct = o.quantity > 0 ? Math.round((o.filled / o.quantity) * 100) : 0;
		lines.push(
			`- ${o.type.toUpperCase()} ${name} [${o.item_id}] x${o.quantity} @ ${o.price_each} cr/ea (${o.filled}/${o.quantity} filled, ${fillPct}%) [order: ${o.order_id}]`,
		);
	}
	return lines.join("\n");
}

function formatStorageSummary(items: StorageItem[], credits: number): string | null {
	if (items.length === 0 && credits === 0) return null;
	const parts: string[] = [];
	if (credits > 0) parts.push(`${credits.toLocaleString()} cr`);
	for (const item of items.slice(0, 10)) {
		const name = (item.item_name || item.item_id).replace(/_/g, " ");
		parts.push(`${name} [${item.item_id}] x${item.quantity}`);
	}
	if (items.length > 10) parts.push(`and ${items.length - 10} more`);
	return `Station storage: ${parts.join(", ")}`;
}

/**
 * Formats alerts into a string for the system prompt.
 */
export function formatAlerts(alerts: Alert[]): string {
	if (alerts.length === 0) return "";

	return alerts
		.map((a) => {
			const icon =
				a.priority === "critical"
					? "!!!"
					: a.priority === "high"
						? "!!"
						: a.priority === "medium"
							? "!"
							: "-";
			return `${icon} ${a.message}`;
		})
		.join("\n");
}

/**
 * Formats social state (chat + forum) into a briefing section.
 */
export function formatSocialBriefing(social: SocialState): string {
	const lines: string[] = [];

	if (social.chatHistory.length > 0) {
		lines.push("## Recent Chat");
		for (const msg of social.chatHistory.slice(-15)) {
			lines.push(`[${msg.channel}] ${msg.sender}: ${msg.content}`);
		}
	}

	if (social.forumThreads.length > 0) {
		lines.push("");
		lines.push("## Forum Threads");
		for (const t of social.forumThreads) {
			lines.push(`- [${t.reply_count}] ${t.title} (by ${t.author}, id:${t.id})`);
		}
	}

	return lines.join("\n");
}
