import { Layer } from "effect"
import { EventProcessorTag, type EventProcessor, type EventResult } from "@roci/core/brain/limbic/thalamus/event-processor.js"
import type { CargoItem, GameState, NearbyPlayer, PendingTrade, PlayerState, PoiState, ShipState, SystemState } from "./types.js"
import type {
  GameEvent,
  LoggedInPayload,
  NotificationChatMessage,
  NotificationBattleUpdate,
  NotificationBattleDamage,
  NotificationMiningYield,
  NotificationObservationUpdate,
  NotificationScanDetected,
  V2GameState,
} from "./ws-types.js"
import { FULL_STATE_FRAME } from "./ws-types.js"

/** A single delta entry from observation_update's nearby_changed / system_changed arrays. */
type NearbyDelta = NonNullable<NotificationObservationUpdate["nearby_changed"]>[number]

/** Map an observation delta entry onto a full NearbyPlayer, filling required fields with safe defaults. */
function deltaToNearby(entry: NearbyDelta): NearbyPlayer {
  return {
    player_id: entry.player_id ?? "",
    username: entry.username ?? "",
    ship_class: entry.ship_class ?? "",
    faction_id: entry.faction_id ?? null,
    faction_tag: entry.faction_tag ?? null,
    status_message: entry.status_message ?? "",
    clan_tag: entry.clan_tag ?? "",
    primary_color: entry.primary_color ?? "",
    secondary_color: entry.secondary_color ?? "",
    anonymous: false,
    in_combat: entry.in_combat,
  }
}

/** Identity key for a nearby player: prefer player_id, fall back to username. */
function nearbyKey(n: { player_id?: string; username?: string }): string {
  return n.player_id && n.player_id.length > 0 ? n.player_id : (n.username ?? "")
}

/**
 * A normalized full player+ship snapshot. Both the `logged_in` handshake and the
 * on-demand `get_state` refresh produce one of these; `applyFullState` is the
 * single merge codepath that folds it onto the prior GameState. Fields are
 * partial so a snapshot only overwrites what it actually carries — a sparse or
 * malformed refresh can never zero out state it omits.
 */
interface FullStateSnapshot {
  player: Partial<PlayerState>
  ship: Partial<ShipState>
  /** Full replacement cargo list. `undefined` = leave prior cargo untouched. */
  cargo?: CargoItem[]
  /** `undefined` = leave prior; `null` = clear; object = merge/replace by id. */
  system?: SystemState | null
  poi?: PoiState | null
  /**
   * Incoming trade offers. `undefined` = leave prior untouched (the `get_state`
   * refresh doesn't carry pending_trades, so it preserves what login set).
   */
  pendingTrades?: PendingTrade[]
}

/**
 * The single full-state merge codepath. Spreads each partial onto the prior
 * state so omitted fields survive. poi/system merge onto the prior object when
 * the id matches (keeping fields the snapshot lacks, e.g. base_id/resources) and
 * replace wholesale when the location changed. Stamps `lastFullStateAt` so the
 * state bar's age indicator reflects a genuine full-state refresh.
 */
function applyFullState(s: GameState, snap: FullStateSnapshot): GameState {
  const player = { ...s.player, ...snap.player } as PlayerState
  const cargo = snap.cargo ?? snap.ship.cargo ?? s.ship.cargo
  const ship = { ...s.ship, ...snap.ship, cargo } as ShipState
  const mergeLocated = <T extends { id: string }>(prev: T | null, next: T | null | undefined): T | null => {
    if (next === undefined) return prev
    if (next === null) return null
    return prev && prev.id === next.id ? { ...prev, ...next } : next
  }
  return {
    ...s,
    player,
    ship,
    cargo,
    system: mergeLocated(s.system, snap.system),
    poi: mergeLocated(s.poi, snap.poi),
    // undefined ⇒ keep prior (get_state has no pending_trades); a login snapshot
    // supplies the fresh array. See the staleness note on loggedInToSnapshot.
    pendingTrades: snap.pendingTrades ?? s.pendingTrades,
    timestamp: Date.now(),
    lastFullStateAt: Date.now(),
  }
}

/**
 * Map the `logged_in` handshake payload onto a normalized full-state snapshot.
 *
 * STALENESS LIMITATION (pending_trades): the handshake is the ONLY frame that
 * carries `pending_trades[]`. Neither the periodic `get_state`/`full_state`
 * refresh (V2GameState has no such field) nor any typed notification refreshes
 * it. The trade-RESOLUTION frames (`trade_cancelled`/`trade_complete`/
 * `trade_declined`) are addressed to the OFFERER, not the recipient whose
 * pending_trades these are, AND fall outside client-v2's typed `ServerEvent`
 * union (they'd need a bridge like `battle_damage`) — so the recipient has no
 * cheap signal for when its incoming offers resolve. Consequently
 * `hasPendingTrades` reflects the login snapshot and only refreshes on
 * reconnect/re-login; it may read stale (stuck true) mid-session after the
 * pilot reviews the offers. Accepted as a documented limitation over building a
 * resolution-frame bridge that the game doesn't route to the recipient anyway.
 */
function loggedInToSnapshot(payload: LoggedInPayload): FullStateSnapshot {
  const ship = payload.ship as unknown as ShipState
  return {
    player: payload.player as unknown as PlayerState,
    ship,
    cargo: ship?.cargo ?? [],
    system: (payload.system as unknown as SystemState) ?? null,
    poi: payload.poi ? (payload.poi as unknown as PoiState) : null,
    pendingTrades: (payload.pending_trades ?? []) as unknown as PendingTrade[],
  }
}

function handleLoggedIn(payload: LoggedInPayload): EventResult {
  return {
    category: { _tag: "StateChange" },
    stateUpdate: (prev) => applyFullState(prev as GameState, loggedInToSnapshot(payload)),
  }
}

/**
 * Map a `get_state` (v2) result onto a full-state snapshot. The get_state shape
 * differs from `logged_in`: player/ship are leaner and location (system/poi/dock
 * status) lives in a dedicated `location` object. We defensively unwrap a
 * `structuredContent` envelope (the REST shape) in case the WS `result` frame
 * carries the same wrapper, then translate location → the domain's
 * player.current_system/current_poi/docked_at_base and minimal system/poi objects
 * (id/name/type) so the state bar shows fresh location + names.
 */
function getStateToSnapshot(raw: Record<string, unknown>): FullStateSnapshot {
  const gs = ((raw.structuredContent as Record<string, unknown> | undefined) ?? raw) as Partial<V2GameState>

  const player: Partial<PlayerState> = {}
  const p = gs.player
  if (p) {
    if (p.id != null) player.id = p.id
    if (p.username != null) player.username = p.username
    if (p.credits != null) player.credits = p.credits
    if (p.empire != null) player.empire = p.empire
    if (p.clan_tag != null) player.clan_tag = p.clan_tag
    if (p.faction_id !== undefined) player.faction_id = p.faction_id ?? null
    if (p.faction_rank !== undefined) player.faction_rank = p.faction_rank ?? null
    if (p.is_cloaked != null) player.is_cloaked = p.is_cloaked
    if (p.status_message != null) player.status_message = p.status_message
    if (p.home_base != null) player.home_base = p.home_base
    if (p.primary_color != null) player.primary_color = p.primary_color
    if (p.secondary_color != null) player.secondary_color = p.secondary_color
  }

  const loc = gs.location
  if (loc) {
    if (loc.system_id != null) player.current_system = loc.system_id
    if (loc.poi_id != null) player.current_poi = loc.poi_id
    // `docked_at` present ⇒ docked; absent ⇒ undocked. Set explicitly (incl. null)
    // so undocking is reflected, not left stale.
    player.docked_at_base = loc.docked_at ?? null
  }

  const ship: Partial<ShipState> = {}
  const sh = gs.ship
  if (sh) {
    const numKeys = [
      "hull", "max_hull", "shield", "max_shield", "shield_recharge", "armor", "speed",
      "fuel", "max_fuel", "cargo_used", "cargo_capacity", "cpu_used", "cpu_capacity",
      "power_used", "power_capacity", "weapon_slots", "defense_slots", "utility_slots",
    ] as const
    for (const k of numKeys) {
      const v = (sh as Record<string, unknown>)[k]
      if (typeof v === "number") (ship as Record<string, unknown>)[k] = v
    }
    if (sh.id != null) ship.id = sh.id
    if (sh.class_id != null) ship.class_id = sh.class_id
    if (sh.name != null) ship.name = sh.name
  }

  const cargo = Array.isArray(gs.cargo)
    ? gs.cargo.map((c) => ({ item_id: String(c.item_id ?? ""), quantity: Number(c.quantity ?? 0) }))
    : undefined

  // Minimal located objects from `location` (undefined = leave prior untouched).
  let system: SystemState | null | undefined
  let poi: PoiState | null | undefined
  if (loc) {
    system =
      loc.system_id != null
        ? ({ id: loc.system_id, name: loc.system_name ?? loc.system_id } as unknown as SystemState)
        : undefined
    poi =
      loc.poi_id != null
        ? ({
            id: loc.poi_id,
            name: loc.poi_name ?? loc.poi_id,
            type: loc.poi_type ?? "",
            system_id: loc.system_id ?? "",
          } as unknown as PoiState)
        : null // in open space (no current POI)
  }

  return { player, ship, cargo, system, poi }
}

/**
 * Handle the synthetic `full_state` frame carrying a `get_state` payload. Always
 * produces a stateUpdate (reconciling drift AND refreshing `lastFullStateAt` so
 * the age indicator is a true liveness signal, even when nothing changed).
 */
function handleFullState(payload: Record<string, unknown>): EventResult {
  return {
    category: { _tag: "StateChange" },
    stateUpdate: (prev) => applyFullState(prev as GameState, getStateToSnapshot(payload)),
  }
}

function handleObservationUpdate(payload: NotificationObservationUpdate): EventResult {
  return {
    category: { _tag: "StateChange" },
    stateUpdate: (prev) => {
      const s = prev as GameState
      const byKey = new Map<string, NearbyPlayer>()
      for (const n of s.nearby) byKey.set(nearbyKey(n), n)
      for (const entry of payload.nearby_changed ?? []) {
        byKey.set(nearbyKey(entry), deltaToNearby(entry))
      }
      for (const departed of payload.nearby_departed ?? []) {
        // `nearby_departed` carries player_ids. Entries upserted without a
        // player_id were keyed by username (see nearbyKey), so fall back to a
        // username sweep when the direct key delete misses.
        if (!byKey.delete(departed)) {
          for (const [k, v] of byKey) {
            if (v.username === departed) {
              byKey.delete(k)
              break
            }
          }
        }
      }
      // The frame carries the current poi_id/system_id every tick — fold them
      // into the player so location no longer freezes at the login snapshot. The
      // friendly names/type still come from full-state refreshes (get_state);
      // here we only have ids, which the renderer falls back to displaying.
      const player =
        payload.poi_id || payload.system_id
          ? {
              ...s.player,
              ...(payload.poi_id ? { current_poi: payload.poi_id } : {}),
              ...(payload.system_id ? { current_system: payload.system_id } : {}),
            }
          : s.player
      return {
        ...s,
        player,
        nearby: Array.from(byKey.values()),
        tick: payload.tick,
        timestamp: Date.now(),
      }
    },
  }
}

function handleBattleUpdate(payload: NotificationBattleUpdate): EventResult {
  // client-v2 1.6.0 split combat into a periodic `battle_update` snapshot (this
  // handler: standing-fight summary, no per-hit fields) plus separate per-hit
  // `battle_damage` push frames (see handleBattleDamage). We drive `inCombat`/
  // `tick` from the snapshot and summarize the standing fight.
  const hostiles = payload.participants.filter((p) => p.side_id !== payload.your_side_id).length
  return {
    category: { _tag: "StateChange" },
    alert: `Battle in progress (stance: ${payload.your_stance}) — ${hostiles} hostile${hostiles === 1 ? "" : "s"} engaged in ${payload.your_zone}.`,
    stateUpdate: (prev) => {
      const s = prev as GameState
      return { ...s, inCombat: true, tick: payload.tick, timestamp: Date.now() }
    },
  }
}

function handleBattleDamage(payload: NotificationBattleDamage): EventResult {
  const attacker = payload.attacker_name ?? payload.attacker_id
  // faithful to the pre-1.6.0 per-hit combat alert style
  return {
    category: { _tag: "StateChange" },
    alert: `Taking fire! ${attacker} hit you for ${payload.total_damage} ${payload.damage_type} damage (shield: ${payload.shield_hit}, hull: ${payload.hull_hit}).`,
    stateUpdate: (prev) => {
      const s = prev as GameState
      return { ...s, inCombat: true, tick: payload.tick, timestamp: Date.now() }
    },
  }
}

function handleMiningYield(payload: NotificationMiningYield): EventResult {
  return {
    category: { _tag: "StateChange" },
    stateUpdate: (prev) => {
      const s = prev as GameState
      const ship = s.ship
      const nextUsed = Math.min(ship.cargo_used + payload.quantity, ship.cargo_capacity)
      const cargo: CargoItem[] = [...(ship.cargo ?? [])]
      const idx = cargo.findIndex((c) => c.item_id === payload.resource_id)
      if (idx >= 0) {
        cargo[idx] = { ...cargo[idx], quantity: cargo[idx].quantity + payload.quantity }
      } else {
        cargo.push({ item_id: payload.resource_id, quantity: payload.quantity })
      }
      return { ...s, ship: { ...ship, cargo_used: nextUsed, cargo }, cargo, timestamp: Date.now() }
    },
  }
}

function handleChatMessage(payload: NotificationChatMessage): EventResult {
  return {
    context: {
      chatMessages: [
        {
          channel: payload.channel ?? "",
          sender: payload.sender ?? "",
          content: payload.content ?? "",
        },
      ],
    },
  }
}

/**
 * SpaceMolt-specific event processor.
 *
 * Maps the `@spacemolt/client-v2` `ServerEvent` union (re-exported as `GameEvent`)
 * onto the domain's `EventResult`. The cortex loop consumes primarily `stateUpdate`
 * (feeding the situation-classifier, state renderer, and interrupts) and `log`;
 * `category`/`alert`/`context` are set for interface correctness.
 */
export const spaceMoltEventProcessor: EventProcessor = {
  processEvent(event, _currentState) {
    // Synthetic host-injected full-state refresh — not a wire ServerEvent, so it
    // is dispatched before the closed `ServerEvent` switch below.
    if ((event as { type?: string }).type === FULL_STATE_FRAME) {
      return handleFullState((event as { payload?: Record<string, unknown> }).payload ?? {})
    }
    const smEvent = event as GameEvent
    switch (smEvent.type) {
      case "logged_in":
        return handleLoggedIn(smEvent.payload)

      case "observation_update":
        return handleObservationUpdate(smEvent.payload)

      case "battle_update":
        return handleBattleUpdate(smEvent.payload)

      case "battle_damage":
        return handleBattleDamage(smEvent.payload)

      case "player_died":
        return {
          category: { _tag: "LifecycleReset", reason: "player_died" },
          stateUpdate: (prev) => {
            const s = prev as GameState
            return { ...s, inCombat: false, timestamp: Date.now() }
          },
        }

      case "chat_message":
        return handleChatMessage(smEvent.payload)

      case "mining_yield":
        return handleMiningYield(smEvent.payload)

      case "scan_detected": {
        const payload = smEvent.payload as NotificationScanDetected
        return { alert: `You were scanned by ${payload.scanner_username}.` }
      }

      // Logging handled externally; preserve a no-op log fn (matches old behavior).
      case "error":
      case "action_error":
        return { log: () => {} }

      // Control acks / informational frames the host doesn't act on. They still
      // reach the hindbrain via the raw event stream.
      case "welcome":
      case "registered":
      case "ok":
      case "result":
      case "action_result":
      case "reconnected":
      case "pilotless_ship":
      case "market_update":
      case "skill_level_up":
      case "trade_offer_received":
      case "crafting_update":
        return {}

      default:
        // Unknown / future / RawServerFrame — never throw.
        return {}
    }
  },
}

/** Layer providing the SpaceMolt event processor as the EventProcessor service. */
export const SpaceMoltEventProcessorLive = Layer.succeed(EventProcessorTag, spaceMoltEventProcessor)
