// =====================================================
// API Layer Types
// =====================================================

export interface GameNotification {
	id?: string;
	type: string;
	msg_type?: string;
	data?: Record<string, unknown>;
	timestamp?: string;
}

// =====================================================
// Game State Types (from API queries)
// =====================================================

export interface PlayerState {
	id: string;
	username: string;
	empire: string;
	credits: number;
	current_system: string;
	current_poi: string;
	current_ship_id: string;
	home_base: string;
	docked_at_base: string | null;
	faction_id: string | null;
	faction_rank: string | null;
	status_message: string;
	clan_tag: string;
	primary_color?: string;
	secondary_color?: string;
	is_cloaked: boolean;
	anonymous: boolean;
	skills: Record<string, number>;
	skill_xp: Record<string, number>;
	stats: Record<string, number>;
}

export interface ShipState {
	id: string;
	owner_id?: string;
	class_id: string;
	name: string;
	hull: number;
	max_hull: number;
	shield: number;
	max_shield: number;
	shield_recharge: number;
	armor: number;
	speed: number;
	fuel: number;
	max_fuel: number;
	cargo_used: number;
	cargo_capacity: number;
	cpu_used: number;
	cpu_capacity: number;
	power_used: number;
	power_capacity: number;
	weapon_slots: number;
	defense_slots: number;
	utility_slots: number;
	damage_penalty?: number;
	speed_penalty?: number;
	disruption_ticks_remaining?: number;
	active_buffs?: Array<Record<string, unknown>>;
	modules: string[];
	cargo: CargoItem[];
}

export interface CargoItem {
	item_id: string;
	quantity: number;
}

export interface PoiState {
	id: string;
	system_id: string;
	type: string;
	name: string;
	description: string;
	hidden?: boolean;
	position: { x: number; y: number };
	resources: PoiResource[];
	base_id: string | null;
}

export interface PoiResource {
	resource_id: string;
	name?: string;
	richness: string;
	remaining: number;
	remaining_display?: string;
}

export interface SystemConnection {
	system_id: string;
	name: string;
	distance?: number;
}

export interface SystemPoi {
	id: string;
	name: string;
	type: string;
	description?: string;
	base_id: string | null;
	has_base?: boolean;
	base_name?: string;
	online?: number;
	position?: { x: number; y: number };
	resources?: PoiResource[];
}

export interface SystemState {
	id: string;
	name: string;
	description: string;
	empire: string;
	police_level: number;
	security_status?: string;
	connections: SystemConnection[];
	pois: SystemPoi[];
	position?: { x: number; y: number };
}

export interface NearbyPlayer {
	player_id: string;
	username: string;
	ship_class: string;
	faction_id: string | null;
	faction_tag: string | null;
	status_message: string;
	clan_tag: string;
	primary_color: string;
	secondary_color: string;
	anonymous: boolean;
	in_combat: boolean;
}

export interface TravelProgress {
	travel_progress: number;
	travel_destination: string;
	travel_type: "travel" | "jump";
	travel_arrival_tick: number;
}

export interface MarketItem {
	item_id: string;
	item_name: string;
	best_buy: number;
	best_sell: number;
	buy_quantity: number;
	sell_quantity: number;
}

export interface PlayerOrder {
	order_id: string;
	item_id: string;
	item_name: string;
	type: "buy" | "sell";
	quantity: number;
	filled: number;
	price_each: number;
	created_at?: string;
}

export interface StorageItem {
	item_id: string;
	item_name: string;
	quantity: number;
}

export interface MissionInfo {
	id: string;
	title: string;
	description: string;
	reward_credits: number;
	reward_xp?: number;
	requirements: string;
}

export interface ActiveMission {
	id: string;
	title: string;
	status: string;
	progress: string;
	reward_credits: number;
}

/**
 * An incoming player-to-player trade offer awaiting the recipient's review.
 * Sourced from the `logged_in` handshake's `pending_trades[]` array (whose
 * entries the client-v2 lib types only as `unknown[]`; shape mirrors
 * `NotificationTradeOfferReceived`). Only `trade_id` is relied upon; the rest is
 * carried for possible future rendering. Presence drives the `pending_trades`
 * interrupt via the `hasPendingTrades` situation flag.
 */
export interface PendingTrade {
	trade_id: string;
	offerer_id?: string;
	offerer_name?: string;
	offer_credits?: number;
	request_credits?: number;
}

export interface GameState {
	player: PlayerState;
	ship: ShipState;
	poi: PoiState | null;
	system: SystemState | null;
	cargo: CargoItem[];
	nearby: NearbyPlayer[];
	notifications: GameNotification[];
	travelProgress: TravelProgress | null;
	inCombat: boolean;
	/**
	 * Whether the live feed is up, from the adapter's `connection_state` frames
	 * (`onDisconnected` / `onReconnecting` / `onReconnected`).
	 *
	 * This is the replacement for the deleted wall-clock staleness signal, and it
	 * is strictly better: the old `lastFullStateAt` age was an INFERENCE that the
	 * socket had died because a 45s poll had stopped landing, and it could only
	 * notice ~90 seconds late. This is the library reporting the fact.
	 * `situation.ts` reads it to warn cognition that its worldview is frozen.
	 */
	connected: boolean;
	tick: number;
	timestamp: number;
	market?: MarketItem[];
	missions?: MissionInfo[];
	activeMissions?: ActiveMission[];
	/**
	 * Incoming trade offers awaiting review. Populated from the `logged_in`
	 * handshake snapshot (and preserved across `get_state`/`full_state` refreshes,
	 * which don't carry it). Drives the `hasPendingTrades` situation flag. See the
	 * staleness note on `loggedInToSnapshot` in event-processor.ts: the domain has
	 * no cheap signal for when these resolve, so this reflects the login snapshot.
	 */
	pendingTrades?: PendingTrade[];
	orders?: PlayerOrder[];
	storage?: StorageItem[];
	storageCredits?: number;
}

// =====================================================
// Situation Engine Types
// =====================================================

export enum SituationType {
	Docked = "docked",
	InSpace = "in_space",
	InTransit = "in_transit",
	InCombat = "in_combat",
}

export interface SituationFlags {
	atMineablePoi: boolean;
	atDockablePoi: boolean;
	lowFuel: boolean;
	cargoNearlyFull: boolean;
	cargoFull: boolean;
	lowHull: boolean;
	hasPendingTrades: boolean;
	hasUnreadChat: boolean;
	hasCompletableMission: boolean;
}

export interface Situation {
	type: SituationType;
	flags: SituationFlags;
}
