// =====================================================
// API Layer Types
// =====================================================

export interface Credentials {
	username: string;
	password: string;
}

export interface ApiSession {
	id: string;
	player_id?: string;
	created_at: string;
	expires_at: string;
}

export interface ApiResponse<T = unknown> {
	result?: T;
	notifications?: GameNotification[];
	session?: ApiSession;
	error?: ApiError;
}

export interface ApiError {
	code: string;
	message: string;
	wait_seconds?: number;
}

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

export interface MapSystem {
	id: string;
	name: string;
	empire?: string;
	connections: string[];
	visited: boolean;
	poiCount: number;
}

export type GalaxyMap = Map<string, MapSystem>;

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

export interface ChatMessage {
	id?: string;
	sender_id?: string;
	sender: string;
	channel: string;
	content: string;
	timestamp?: number;
}

export interface ForumThread {
	id: string;
	title: string;
	author: string;
	category?: string;
	reply_count: number;
	last_activity?: number;
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
	tick: number;
	timestamp: number;
	market?: MarketItem[];
	missions?: MissionInfo[];
	activeMissions?: ActiveMission[];
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

export interface Alert {
	priority: "critical" | "high" | "medium" | "low";
	message: string;
	suggestedAction?: string;
}

export interface Situation {
	type: SituationType;
	flags: SituationFlags;
	alerts: Alert[];
}

// =====================================================
// Social Data Types
// =====================================================

export interface SocialState {
	chatHistory: ChatMessage[];
	forumThreads: ForumThread[];
}
