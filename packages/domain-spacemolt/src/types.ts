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

/**
 * Combat participation bookkeeping, owned by the event processor and read by
 * the combat-onset reflex (`reflexes.ts`).
 *
 * `onsetSeq` is the whole design. The reflex MUST fire once per fight and must
 * NOT re-fire for its duration — that is the exact failure of the deleted
 * `hull_critical` rule, a level condition that persisted for many ticks and
 * destroyed, every tick, the plan that would have ended it. A monotonic counter
 * incremented once per fresh onset gives the reflex an exact edge to compare
 * against, instead of a level it has to guess about.
 */
export interface CombatState {
	/** Game tick of the most recent combat frame you were a participant in. */
	readonly lastEventTick: number | null;
	/** Incremented once per fresh ONSET (a transition into being a participant). */
	readonly onsetSeq: number;
}

export interface GameState {
	player: PlayerState;
	ship: ShipState;
	poi: PoiState | null;
	system: SystemState | null;
	cargo: CargoItem[];
	nearby: NearbyPlayer[];
	inCombat: boolean;
	/** Combat participation bookkeeping — see CombatState. */
	combat: CombatState;
	/**
	 * You died and the phase machine has not yet acted on it.
	 *
	 * Set by `player_died`, and cleared by `phases.ts`'s `Interrupted` branch —
	 * consuming the phase exit IS the acknowledgement. Without that clear the
	 * critical would re-fire the instant the `active` phase restarted, and the
	 * character would ping-pong through the phase machine forever.
	 */
	deathPending: boolean;
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
}

// =====================================================
// Situation Engine Types
// =====================================================

export enum SituationType {
	Docked = "docked",
	InSpace = "in_space",
	InCombat = "in_combat",
}

/**
 * What is left of the situation flags after the severity system was deleted.
 *
 * There were nine. Eight had ZERO consumers once `interrupts.ts` went, and two
 * of those — `hasUnreadChat` and `hasCompletableMission` — were structurally
 * incapable of ever being true, because the `GameState` fields they read
 * (`notifications`, `activeMissions`) had no writer anywhere in the domain.
 *
 * `atMineablePoi` survives on one real reader: `briefing.ts`, which lists the
 * POI's mineable resources when it is set.
 *
 * NOTE the fuel/hull/cargo bands did NOT die with the flags — they moved, and
 * were always the more useful form. `LOW_FUEL_THRESHOLD`, `LOW_HULL_THRESHOLD`
 * and `HULL_CRITICAL_THRESHOLD` (`situation-classifier.ts`) are imported
 * directly by `event-digest.ts` and are the STATUS line's bands, which is what
 * the appraiser actually reads.
 */
export interface SituationFlags {
	atMineablePoi: boolean;
}

export interface Situation {
	type: SituationType;
	flags: SituationFlags;
}
