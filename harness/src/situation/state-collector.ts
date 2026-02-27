import type { SpaceMoltAPI } from "../api/client.js";
import type {
	GameState,
	PlayerState,
	ShipState,
	PoiState,
	PoiResource,
	SystemState,
	SystemConnection,
	SystemPoi,
	NearbyPlayer,
	CargoItem,
	GameNotification,
	TravelProgress,
	MarketItem,
	PlayerOrder,
	StorageItem,
	MissionInfo,
	ActiveMission,
	SocialState,
	ChatMessage,
	ForumThread,
	GalaxyMap,
	MapSystem,
} from "../types.js";

/**
 * Queries game state from multiple API endpoints in parallel.
 * Always queries status + poi + system + cargo.
 * Conditionally queries nearby (undocked) and base-specific data (docked).
 */
export async function collectGameState(api: SpaceMoltAPI): Promise<GameState> {
	const notifications: GameNotification[] = [];

	// Always fetch these (queries are free)
	const [statusResp, poiResp, systemResp, cargoResp] = await Promise.all([
		api.execute("get_status"),
		api.execute("get_poi"),
		api.execute("get_system"),
		api.execute("get_cargo"),
	]);

	for (const resp of [statusResp, poiResp, systemResp, cargoResp]) {
		if (resp.notifications) notifications.push(...resp.notifications);
	}

	const statusResult = statusResp.result as Record<string, unknown> | undefined;
	const player = extractPlayer(statusResult);
	const ship = extractShip(statusResult);
	const travelProgress = extractTravelProgress(statusResult);
	const inCombat = (statusResult?.in_combat as boolean) ?? false;
	const tick = (statusResult?.tick as number) ?? 0;

	const poi = extractPoi(poiResp.result as Record<string, unknown> | undefined);
	const system = extractSystem(systemResp.result as Record<string, unknown> | undefined);
	const cargo = extractCargo(cargoResp.result);

	// Nearby players
	let nearby: NearbyPlayer[] = [];
	if (travelProgress) {
		// In transit — skip nearby query
	} else if (player.docked_at_base) {
		// Docked: fetch nearby alongside docked enrichment below
	} else {
		const nearbyResp = await api.execute("get_nearby");
		if (nearbyResp.notifications) notifications.push(...nearbyResp.notifications);
		nearby = extractNearby(nearbyResp.result);
	}

	// Docked enrichment: market, missions, active missions, orders, storage, nearby
	let market: MarketItem[] | undefined;
	let missions: MissionInfo[] | undefined;
	let activeMissions: ActiveMission[] | undefined;
	let orders: PlayerOrder[] | undefined;
	let storage: StorageItem[] | undefined;
	let storageCredits: number | undefined;

	if (player.docked_at_base) {
		const [marketResp, missionsResp, activeMissionsResp, ordersResp, storageResp, nearbyResp] =
			await Promise.all([
				api.execute("view_market"),
				api.execute("get_missions"),
				api.execute("get_active_missions"),
				api.execute("view_orders"),
				api.execute("view_storage"),
				api.execute("get_nearby"),
			]);
		for (const resp of [
			marketResp,
			missionsResp,
			activeMissionsResp,
			ordersResp,
			storageResp,
			nearbyResp,
		]) {
			if (resp.notifications) notifications.push(...resp.notifications);
		}
		market = extractMarket(marketResp.result);
		missions = extractMissions(missionsResp.result);
		activeMissions = extractActiveMissions(activeMissionsResp.result);
		orders = extractOrders(ordersResp.result);
		const storageData = extractStorage(storageResp.result);
		storage = storageData.items;
		storageCredits = storageData.credits;
		nearby = extractNearby(nearbyResp.result);
	}

	return {
		player,
		ship,
		poi,
		system,
		cargo,
		nearby,
		notifications: deduplicateNotifications(notifications),
		travelProgress,
		inCombat,
		tick,
		timestamp: Date.now(),
		market,
		missions,
		activeMissions,
		orders,
		storage,
		storageCredits,
	};
}

export function extractPlayer(data: Record<string, unknown> | undefined): PlayerState {
	if (!data) return emptyPlayer();
	const p = (data.player ?? data) as Record<string, unknown>;
	return {
		id: (p.id as string) ?? "",
		username: (p.username as string) ?? "",
		empire: (p.empire as string) ?? "",
		credits: (p.credits as number) ?? 0,
		current_system: (p.current_system as string) ?? "",
		current_poi: (p.current_poi as string) ?? "",
		current_ship_id: (p.current_ship_id as string) ?? "",
		home_base: (p.home_base as string) ?? "",
		docked_at_base: (p.docked_at_base as string | null) ?? null,
		faction_id: (p.faction_id as string | null) ?? null,
		faction_rank: (p.faction_rank as string | null) ?? null,
		status_message: (p.status_message as string) ?? "",
		clan_tag: (p.clan_tag as string) ?? "",
		is_cloaked: (p.is_cloaked as boolean) ?? false,
		anonymous: (p.anonymous as boolean) ?? false,
		skills: (p.skills as Record<string, number>) ?? {},
		skill_xp: (p.skill_xp as Record<string, number>) ?? {},
		stats: (p.stats as Record<string, number>) ?? {},
	};
}

export function extractShip(data: Record<string, unknown> | undefined): ShipState {
	if (!data) return emptyShip();
	const s = (data.ship ?? data) as Record<string, unknown>;
	return {
		id: (s.id as string) ?? "",
		class_id: (s.class_id as string) ?? "",
		name: (s.name as string) ?? "",
		hull: (s.hull as number) ?? 0,
		max_hull: (s.max_hull as number) ?? 0,
		shield: (s.shield as number) ?? 0,
		max_shield: (s.max_shield as number) ?? 0,
		shield_recharge: (s.shield_recharge as number) ?? 0,
		armor: (s.armor as number) ?? 0,
		speed: (s.speed as number) ?? 0,
		fuel: (s.fuel as number) ?? 0,
		max_fuel: (s.max_fuel as number) ?? 0,
		cargo_used: (s.cargo_used as number) ?? 0,
		cargo_capacity: (s.cargo_capacity as number) ?? 0,
		cpu_used: (s.cpu_used as number) ?? 0,
		cpu_capacity: (s.cpu_capacity as number) ?? 0,
		power_used: (s.power_used as number) ?? 0,
		power_capacity: (s.power_capacity as number) ?? 0,
		weapon_slots: (s.weapon_slots as number) ?? 0,
		defense_slots: (s.defense_slots as number) ?? 0,
		utility_slots: (s.utility_slots as number) ?? 0,
		modules: (s.modules as string[]) ?? [],
		cargo: (s.cargo as CargoItem[]) ?? [],
	};
}

export function extractTravelProgress(
	data: Record<string, unknown> | undefined,
): TravelProgress | null {
	if (!data?.travel_progress) return null;
	return {
		travel_progress: data.travel_progress as number,
		travel_destination: (data.travel_destination as string) ?? "",
		travel_type: (data.travel_type as "travel" | "jump") ?? "travel",
		travel_arrival_tick: (data.travel_arrival_tick as number) ?? 0,
	};
}

export function extractPoi(data: Record<string, unknown> | undefined): PoiState | null {
	if (!data) return null;
	const p = (data.poi ?? data) as Record<string, unknown>;
	if (!p || !p.id) return null;
	return {
		id: (p.id as string) ?? "",
		system_id: (p.system_id as string) ?? "",
		type: (p.type as string) ?? "",
		name: (p.name as string) ?? "",
		description: (p.description as string) ?? "",
		position: (p.position as { x: number; y: number }) ?? { x: 0, y: 0 },
		resources: (p.resources as PoiState["resources"]) ?? [],
		base_id: (p.base_id as string | null) ?? null,
	};
}

export function extractSystem(data: Record<string, unknown> | undefined): SystemState | null {
	if (!data) return null;
	const s = (data.system ?? data) as Record<string, unknown>;
	if (!s || !s.id) return null;

	const rawPois = (data.pois ?? s.pois ?? []) as unknown[];
	const pois: SystemPoi[] = Array.isArray(rawPois)
		? rawPois.map((raw) => {
				const p = raw as Record<string, unknown>;
				return {
					id: (p.id as string) ?? "",
					name: (p.name as string) ?? "",
					type: (p.type as string) ?? "",
					description: p.description as string | undefined,
					base_id: (p.base_id as string | null) ?? null,
					has_base: p.has_base as boolean | undefined,
					base_name: p.base_name as string | undefined,
					online: p.online as number | undefined,
					position: p.position as { x: number; y: number } | undefined,
					resources: p.resources as PoiResource[] | undefined,
				};
			})
		: [];

	const rawConns = (s.connections ?? []) as unknown[];
	const connections: SystemConnection[] = Array.isArray(rawConns)
		? rawConns.map((raw) => {
				if (typeof raw === "string") {
					return { system_id: raw, name: raw };
				}
				const c = raw as Record<string, unknown>;
				return {
					system_id: (c.system_id as string) ?? "",
					name: (c.name as string) ?? "",
					distance: c.distance as number | undefined,
				};
			})
		: [];

	return {
		id: (s.id as string) ?? "",
		name: (s.name as string) ?? "",
		description: (s.description as string) ?? "",
		empire: (s.empire as string) ?? "",
		police_level: (s.police_level as number) ?? 0,
		security_status: s.security_status as string | undefined,
		connections,
		pois,
		position: s.position as { x: number; y: number } | undefined,
	};
}

export function extractCargo(data: unknown): CargoItem[] {
	if (!data || !Array.isArray(data)) {
		const obj = data as Record<string, unknown> | undefined;
		if (obj?.cargo && Array.isArray(obj.cargo)) return obj.cargo as CargoItem[];
		return [];
	}
	return data as CargoItem[];
}

export function extractNearby(data: unknown): NearbyPlayer[] {
	if (!data) return [];
	const obj = data as Record<string, unknown>;
	const players = (obj.players ?? obj.nearby ?? data) as unknown;
	if (Array.isArray(players)) return players as NearbyPlayer[];
	return [];
}

export function extractMarket(data: unknown): MarketItem[] {
	if (!data) return [];
	const obj = data as Record<string, unknown>;
	const items = (obj.items ?? obj.orders ?? obj.listings ?? obj.market ?? data) as unknown;
	if (Array.isArray(items)) {
		return items.map((item: Record<string, unknown>) => {
			const buyOrders = (item.buy_orders ?? []) as Array<Record<string, unknown>>;
			const sellOrders = (item.sell_orders ?? []) as Array<Record<string, unknown>>;
			return {
				item_id: (item.item_id as string) ?? "",
				item_name: (item.item_name as string) ?? ((item.item_id as string) ?? ""),
				best_buy: (item.best_buy as number) ?? 0,
				best_sell: (item.best_sell as number) ?? 0,
				buy_quantity: buyOrders.reduce(
					(sum, o) => sum + ((o.quantity as number) ?? 0),
					0,
				),
				sell_quantity: sellOrders.reduce(
					(sum, o) => sum + ((o.quantity as number) ?? 0),
					0,
				),
			};
		});
	}
	return [];
}

export function extractMissions(data: unknown): MissionInfo[] {
	if (!data) return [];
	const obj = data as Record<string, unknown>;
	const list = (obj.missions ?? obj.available ?? data) as unknown;
	if (Array.isArray(list)) {
		return list.map((m: Record<string, unknown>) => {
			const rewards = (m.rewards ?? {}) as Record<string, unknown>;
			const rewardXp = rewards.skill_xp as Record<string, number> | undefined;
			return {
				id: ((m.mission_id ?? m.id) as string) ?? "",
				title: ((m.title ?? m.name) as string) ?? "",
				description: (m.description as string) ?? "",
				reward_credits: ((rewards.credits ?? m.reward_credits) as number) ?? 0,
				reward_xp: rewardXp ? Object.values(rewardXp).reduce((a, b) => a + b, 0) : undefined,
				requirements: summarizeRequirements(m),
			};
		});
	}
	return [];
}

export function extractOrders(data: unknown): PlayerOrder[] {
	if (!data) return [];
	const obj = data as Record<string, unknown>;
	const list = (obj.orders ?? obj.buy_orders ?? obj.sell_orders ?? data) as unknown;
	if (Array.isArray(list)) {
		return list.map((raw: Record<string, unknown>) => ({
			order_id: ((raw.order_id ?? raw.id) as string) ?? "",
			item_id: (raw.item_id as string) ?? "",
			item_name: (raw.item_name as string) ?? ((raw.item_id as string) ?? ""),
			type: (raw.type as "buy" | "sell") ?? ((raw.side as string) === "buy" ? "buy" : "sell"),
			quantity: (raw.quantity as number) ?? 0,
			filled: (raw.filled as number) ?? 0,
			price_each: ((raw.price_each ?? raw.price) as number) ?? 0,
			created_at: raw.created_at as string | undefined,
		}));
	}
	// view_orders might return separate buy_orders and sell_orders arrays
	const buyOrders = obj.buy_orders as unknown[];
	const sellOrders = obj.sell_orders as unknown[];
	const combined: PlayerOrder[] = [];
	if (Array.isArray(buyOrders)) {
		for (const raw of buyOrders) {
			const o = raw as Record<string, unknown>;
			combined.push({
				order_id: ((o.order_id ?? o.id) as string) ?? "",
				item_id: (o.item_id as string) ?? "",
				item_name: (o.item_name as string) ?? ((o.item_id as string) ?? ""),
				type: "buy",
				quantity: (o.quantity as number) ?? 0,
				filled: (o.filled as number) ?? 0,
				price_each: ((o.price_each ?? o.price) as number) ?? 0,
				created_at: o.created_at as string | undefined,
			});
		}
	}
	if (Array.isArray(sellOrders)) {
		for (const raw of sellOrders) {
			const o = raw as Record<string, unknown>;
			combined.push({
				order_id: ((o.order_id ?? o.id) as string) ?? "",
				item_id: (o.item_id as string) ?? "",
				item_name: (o.item_name as string) ?? ((o.item_id as string) ?? ""),
				type: "sell",
				quantity: (o.quantity as number) ?? 0,
				filled: (o.filled as number) ?? 0,
				price_each: ((o.price_each ?? o.price) as number) ?? 0,
				created_at: o.created_at as string | undefined,
			});
		}
	}
	return combined;
}

export function extractStorage(data: unknown): { items: StorageItem[]; credits: number } {
	if (!data) return { items: [], credits: 0 };
	const obj = data as Record<string, unknown>;
	const credits = (obj.credits as number) ?? 0;
	const items = (obj.items ?? obj.storage ?? obj.inventory) as unknown;
	if (Array.isArray(items)) {
		return {
			credits,
			items: items.map((raw: Record<string, unknown>) => ({
				item_id: (raw.item_id as string) ?? "",
				item_name: (raw.item_name as string) ?? ((raw.item_id as string) ?? ""),
				quantity: (raw.quantity as number) ?? 0,
			})),
		};
	}
	return { items: [], credits };
}

export function extractActiveMissions(data: unknown): ActiveMission[] {
	if (!data) return [];
	const obj = data as Record<string, unknown>;
	const list = (obj.missions ?? obj.active ?? data) as unknown;
	if (Array.isArray(list)) {
		return list.map((m: Record<string, unknown>) => {
			const rewards = (m.rewards ?? {}) as Record<string, unknown>;
			const objectives = (m.objectives ?? []) as Array<Record<string, unknown>>;
			const allComplete = objectives.length > 0 && objectives.every((o) => o.completed);
			const status = allComplete ? "completed" : ((m.status as string) ?? "active");
			return {
				id: ((m.mission_id ?? m.id) as string) ?? "",
				title: ((m.title ?? m.name) as string) ?? "",
				status,
				progress: summarizeObjectiveProgress(objectives),
				reward_credits: ((rewards.credits ?? m.reward_credits) as number) ?? 0,
			};
		});
	}
	return [];
}

/**
 * Queries social data: chat history and forum threads.
 */
export async function collectSocialState(api: SpaceMoltAPI): Promise<SocialState> {
	const channels = ["system", "local", "faction"] as const;
	const [forumResp, ...chatResps] = await Promise.all([
		api.execute("forum_list").catch(() => ({ result: undefined })),
		...channels.map((channel) =>
			api
				.execute("get_chat_history", { channel, limit: 20 })
				.catch(() => ({ result: undefined })),
		),
	]);

	const chatHistory = chatResps.flatMap((resp) => extractChatHistory(resp.result));

	return {
		chatHistory,
		forumThreads: extractForumThreads(forumResp.result),
	};
}

export function extractChatHistory(data: unknown): ChatMessage[] {
	if (!data) return [];
	const obj = data as Record<string, unknown>;
	const messages = (obj.messages ?? obj.chat ?? obj.history ?? data) as unknown;
	if (!Array.isArray(messages)) return [];
	return messages.map((m: Record<string, unknown>) => ({
		sender: ((m.sender ?? m.sender_name ?? m.from ?? m.username) as string) ?? "unknown",
		channel: ((m.channel ?? m.type) as string) ?? "unknown",
		content: ((m.content ?? m.message ?? m.text) as string) ?? "",
		timestamp: (m.timestamp ?? m.created_at) as number | undefined,
	}));
}

export function extractForumThreads(data: unknown): ForumThread[] {
	if (!data) return [];
	const obj = data as Record<string, unknown>;
	const threads = (obj.threads ?? obj.posts ?? obj.topics ?? data) as unknown;
	if (!Array.isArray(threads)) return [];
	return threads.map((t: Record<string, unknown>) => ({
		id: ((t.id ?? t.thread_id) as string) ?? "",
		title: ((t.title ?? t.subject ?? t.name) as string) ?? "",
		author: ((t.author ?? t.author_name ?? t.created_by) as string) ?? "unknown",
		category: (t.category ?? t.forum) as string | undefined,
		reply_count: ((t.reply_count ?? t.replies ?? t.comment_count) as number) ?? 0,
		last_activity: (t.last_activity ?? t.updated_at) as number | undefined,
	}));
}

/**
 * Fetches the galaxy map once on startup.
 */
export async function fetchGalaxyMap(api: SpaceMoltAPI): Promise<GalaxyMap> {
	const resp = await api.execute("get_map");
	const map: GalaxyMap = new Map();

	if (!resp.result || typeof resp.result !== "object") return map;
	const data = resp.result as Record<string, unknown>;
	const systems = data.systems as unknown[];
	if (!Array.isArray(systems)) return map;

	for (const raw of systems) {
		const s = raw as Record<string, unknown>;
		const id = (s.system_id as string) ?? "";
		if (!id) continue;
		map.set(id, {
			id,
			name: (s.name as string) ?? id,
			empire: s.empire as string | undefined,
			connections: (s.connections as string[]) ?? [],
			visited: (s.visited as boolean) ?? false,
			poiCount: (s.poi_count as number) ?? 0,
		});
	}

	return map;
}

function summarizeRequirements(m: Record<string, unknown>): string {
	const objectives = m.objectives as Array<Record<string, unknown>> | undefined;
	if (objectives && objectives.length > 0) {
		return objectives.map((o) => (o.description as string) ?? `${o.type}`).join("; ");
	}
	if (m.target_item && m.target_quantity) {
		return `${m.target_quantity} ${(m.target_item as string).replace(/_/g, " ")}`;
	}
	if (m.objective) return m.objective as string;
	return "";
}

function summarizeObjectiveProgress(objectives: Array<Record<string, unknown>>): string {
	if (objectives.length === 0) return "";
	return objectives
		.map((o) => {
			const current = o.current as number | undefined;
			const required = o.required as number | undefined;
			if (current != null && required != null) {
				return `${current}/${required} ${((o.description as string) ?? "").replace(/^Mine \d+ units of /, "").replace(/^Deliver \d+ /, "")}`;
			}
			return (o.description as string) ?? "";
		})
		.join("; ");
}

function deduplicateNotifications(notifications: GameNotification[]): GameNotification[] {
	const seen = new Set<string>();
	return notifications.filter((n) => {
		const key = n.id ?? `${n.msg_type ?? n.type}:${JSON.stringify(n.data)}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function emptyPlayer(): PlayerState {
	return {
		id: "",
		username: "",
		empire: "",
		credits: 0,
		current_system: "",
		current_poi: "",
		current_ship_id: "",
		home_base: "",
		docked_at_base: null,
		faction_id: null,
		faction_rank: null,
		status_message: "",
		clan_tag: "",
		is_cloaked: false,
		anonymous: false,
		skills: {},
		skill_xp: {},
		stats: {},
	};
}

function emptyShip(): ShipState {
	return {
		id: "",
		class_id: "",
		name: "",
		hull: 0,
		max_hull: 0,
		shield: 0,
		max_shield: 0,
		shield_recharge: 0,
		armor: 0,
		speed: 0,
		fuel: 0,
		max_fuel: 0,
		cargo_used: 0,
		cargo_capacity: 0,
		cpu_used: 0,
		cpu_capacity: 0,
		power_used: 0,
		power_capacity: 0,
		weapon_slots: 0,
		defense_slots: 0,
		utility_slots: 0,
		modules: [],
		cargo: [],
	};
}
