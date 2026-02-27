import type {
  PlayerState,
  ShipState,
  SystemState,
  PoiState,
  NearbyPlayer,
} from "./types.js"

// =====================================================
// Server → Client Events
// =====================================================

export interface WelcomeEvent {
  type: "welcome"
  payload: {
    version: string
    release_date: string
    release_notes: string[]
    tick_rate: number
    current_tick: number
    server_time: number
    motd?: string
    game_info: string
    website: string
    help_text: string
    terms: string
  }
}

export interface RegisteredEvent {
  type: "registered"
  payload: {
    password: string
    player_id: string
  }
}

export interface LoggedInEvent {
  type: "logged_in"
  payload: {
    player: PlayerState
    ship: ShipState
    system: SystemState
    poi: PoiState | null
    captains_log: Array<Record<string, unknown>>
    pending_trades: Array<Record<string, unknown>>
  }
}

export interface StateUpdateEvent {
  type: "state_update"
  payload: {
    tick: number
    player: PlayerState
    ship: ShipState
    nearby: NearbyPlayer[]
    in_combat: boolean
    travel_progress?: number
    travel_destination?: string
    travel_type?: "travel" | "jump"
    travel_arrival_tick?: number
  }
}

export interface TickEvent {
  type: "tick"
  payload: {
    tick: number
  }
}

export interface OkEvent {
  type: "ok"
  payload: Record<string, unknown>
}

export interface ErrorEvent {
  type: "error"
  payload: {
    code: string
    message: string
    wait_seconds?: number
  }
}

export interface CombatUpdateEvent {
  type: "combat_update"
  payload: {
    tick: number
    attacker: string
    target: string
    damage: number
    damage_type: string
    shield_hit: number
    hull_hit: number
    destroyed: boolean
  }
}

export interface PlayerDiedEvent {
  type: "player_died"
  payload: {
    killer_id: string
    killer_name: string
    respawn_base: string
    cause: string
    combat_log: Array<Record<string, unknown>>
  }
}

export interface MiningYieldEvent {
  type: "mining_yield"
  payload: {
    resource_id: string
    quantity: number
    remaining: number
  }
}

export interface ChatMessageEvent {
  type: "chat_message"
  payload: {
    id: string
    channel: string
    sender_id: string
    sender: string
    content: string
    timestamp: number
  }
}

export interface TradeOfferReceivedEvent {
  type: "trade_offer_received"
  payload: {
    trade_id: string
    from_player: string
    from_name: string
    offer_items: Array<Record<string, unknown>>
    offer_credits: number
    request_items: Array<Record<string, unknown>>
    request_credits: number
  }
}

export interface SkillLevelUpEvent {
  type: "skill_level_up"
  payload: {
    skill_id: string
    new_level: number
    xp_gained: number
  }
}

export interface PoiArrivalEvent {
  type: "poi_arrival"
  payload: {
    username: string
    clan_tag?: string
    poi_name: string
    poi_id: string
  }
}

export interface PoiDepartureEvent {
  type: "poi_departure"
  payload: {
    username: string
    clan_tag?: string
    poi_name: string
    poi_id: string
  }
}

export interface ScanResultEvent {
  type: "scan_result"
  payload: {
    target_id: string
    success: boolean
    revealed_info: string[]
    [key: string]: unknown
  }
}

export interface ScanDetectedEvent {
  type: "scan_detected"
  payload: {
    scanner_id: string
    scanner_username: string
    scanner_ship_class: string
    revealed_info: string[]
    message: string
  }
}

export interface PilotlessShipEvent {
  type: "pilotless_ship"
  payload: {
    player_id: string
    player_username: string
    ship_class: string
    poi_id: string
    expire_tick: number
    ticks_remaining: number
  }
}

export interface ReconnectedEvent {
  type: "reconnected"
  payload: {
    message: string
    was_pilotless: boolean
    ticks_remaining: number
  }
}

/** Catch-all for event types we haven't defined yet. */
export interface UnknownEvent {
  type: string
  payload?: unknown
}

// =====================================================
// Discriminated Union
// =====================================================

export type GameEvent =
  | WelcomeEvent
  | RegisteredEvent
  | LoggedInEvent
  | StateUpdateEvent
  | TickEvent
  | OkEvent
  | ErrorEvent
  | CombatUpdateEvent
  | PlayerDiedEvent
  | MiningYieldEvent
  | ChatMessageEvent
  | TradeOfferReceivedEvent
  | SkillLevelUpEvent
  | PoiArrivalEvent
  | PoiDepartureEvent
  | ScanResultEvent
  | ScanDetectedEvent
  | PilotlessShipEvent
  | ReconnectedEvent

/**
 * Parse a raw WS message into a GameEvent.
 * Unknown event types are cast to GameEvent — the consumer's switch/default handles them.
 * The UnknownEvent type above is available for explicit typing if needed.
 */
export function parseGameEvent(data: string): GameEvent {
  const parsed = JSON.parse(data)
  return parsed as GameEvent
}

// =====================================================
// Client → Server Messages
// =====================================================

export type ClientMessage =
  | { type: "login"; payload: { username: string; password: string } }
  | { type: "logout" }
  | { type: "register"; payload: { username: string; empire: string; registration_code: string } }
