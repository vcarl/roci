import { Layer } from "effect"
import { EventProcessorTag, type EventProcessor, type EventResult } from "@roci/core/core/limbic/thalamus/event-processor.js"
import type { CargoItem, GameState, NearbyPlayer, PlayerState, PoiState, ShipState, SystemState } from "./types.js"
import type {
  GameEvent,
  LoggedInPayload,
  NotificationChatMessage,
  NotificationCombatUpdate,
  NotificationMiningYield,
  NotificationObservationUpdate,
  NotificationScanDetected,
} from "./ws-types.js"

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

function handleLoggedIn(payload: LoggedInPayload): EventResult {
  return {
    category: { _tag: "StateChange" },
    stateUpdate: (prev) => {
      const s = prev as GameState
      const ship = payload.ship as unknown as ShipState
      return {
        ...s,
        player: payload.player as unknown as PlayerState,
        ship,
        system: (payload.system as unknown as SystemState) ?? null,
        poi: payload.poi ? (payload.poi as unknown as PoiState) : null,
        cargo: ship?.cargo ?? [],
        tick: s.tick,
        timestamp: Date.now(),
      }
    },
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
      return {
        ...s,
        nearby: Array.from(byKey.values()),
        tick: payload.tick,
        timestamp: Date.now(),
      }
    },
  }
}

function handleCombatUpdate(payload: NotificationCombatUpdate): EventResult {
  return {
    category: { _tag: "StateChange" },
    alert: `Combat engaged! ${payload.attacker} is attacking you — ${payload.damage_type} hit for ${payload.damage} damage (shield: ${payload.shield_hit}, hull: ${payload.hull_hit}).`,
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
    const smEvent = event as GameEvent
    switch (smEvent.type) {
      case "logged_in":
        return handleLoggedIn(smEvent.payload)

      case "observation_update":
        return handleObservationUpdate(smEvent.payload)

      case "combat_update":
        return handleCombatUpdate(smEvent.payload)

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
      case "scan_result":
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
