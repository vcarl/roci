import { Layer } from "effect"
import { EventProcessorTag, type EventProcessor, type EventResult } from "@roci/core/brain/limbic/thalamus/event-processor.js"
import type {
  NotificationBattleDamage,
  NotificationBattleUpdate,
  NotificationChatMessage,
  NotificationMiningYield,
  NotificationObservationUpdate,
} from "@spacemolt/lib"
import type { CargoItem, GameState, NearbyPlayer, PlayerState, ShipState } from "./types.js"
import type { GameEvent } from "./game-events.js"
import { CONNECTION_STATE_FRAME, STATE_SYNC_FRAME } from "./game-events.js"
import type { FullStateSnapshot } from "./lib-state.js"

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
    // The library's generated `NearbyPlayer` (@spacemolt/lib) marks `in_combat`
    // optional, unlike client-v2's hand-written inline type this replaced (which
    // required it) — default to false like every other field here.
    in_combat: entry.in_combat ?? false,
  }
}

/** Identity key for a nearby player: prefer player_id, fall back to username. */
function nearbyKey(n: { player_id?: string; username?: string }): string {
  return n.player_id && n.player_id.length > 0 ? n.player_id : (n.username ?? "")
}

/**
 * The single full-state merge codepath. SURVIVES the rebuild, repointed: it now
 * folds a `FullStateSnapshot` produced by `libStateToSnapshot` from the
 * library's StateCache instead of one produced by the dead `get_state`
 * translator. Its behavior is unchanged and is still what a section fold wants.
 *
 * Spreads each partial onto the prior state so omitted fields survive — a sparse
 * or degraded snapshot can never zero out state it does not carry. poi/system
 * MERGE onto the prior object when the id matches (keeping fields the snapshot
 * lacks, e.g. a POI's full resource list from a richer earlier read) and REPLACE
 * wholesale when the location changed.
 */
function applyFullState(s: GameState, snap: FullStateSnapshot): GameState {
  const player = { ...s.player, ...snap.player } as PlayerState
  // `snap.ship` is typed required, but a real state_sync only carries the
  // sections that changed (e.g. `poi` alone) — optional chain the direct
  // member access rather than trust the type, matching the spreads below,
  // which already tolerate `snap.ship` being absent.
  const cargo = snap.cargo ?? snap.ship?.cargo ?? s.ship.cargo
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
    timestamp: Date.now(),
  }
}

/** The `state_sync` frame's payload (minted by `account-socket.ts`). */
interface StateSyncPayload {
  readonly sections?: ReadonlyArray<string>
  readonly tick?: number
  readonly snapshot?: FullStateSnapshot
}

/**
 * Fold a host `state_sync` frame — the library's StateCache delta, already
 * translated — onto the prior state.
 *
 * Successor to `handleFullState`, and the differences are the point. That one
 * arrived every 45 seconds carrying a ~9KB `get_state` dump whether or not
 * anything had changed; this one arrives only when a section actually changed,
 * carries the changed section NAMES, and is suppressed entirely when the only
 * "change" was `subscribeObservation()`'s presence bridge patching
 * `nearby_players` into the location section (see `shouldEmitStateSync`).
 *
 * A malformed frame (no `snapshot`) is a no-op rather than a state wipe.
 */
function handleStateSync(payload: StateSyncPayload): EventResult {
  const snapshot = payload.snapshot
  if (!snapshot) return {}
  const tick = payload.tick
  return {
    category: { _tag: "StateChange" },
    stateUpdate: (prev) => {
      const next = applyFullState(prev as GameState, snapshot)
      return typeof tick === "number" && tick > 0 ? { ...next, tick } : next
    },
  }
}

/**
 * Fold a host `connection_state` frame onto the prior state.
 *
 * This is the REPLACEMENT for the deleted staleness signal, and it must not be
 * dropped: `connected` is the character's only indication that its worldview is
 * frozen rather than merely quiet. `situation.ts` turns it into the warning that
 * leads the briefing.
 *
 * Deliberately NOT a `LifecycleReset`: a dropped socket does not void the plan.
 * The library reconnects, re-authenticates and re-subscribes on its own, and the
 * character should be told its data is stale, not have its work destroyed.
 */
function handleConnectionState(payload: { connected?: unknown }): EventResult {
  const connected = payload.connected === true
  return {
    category: { _tag: "StateChange" },
    stateUpdate: (prev) => ({ ...(prev as GameState), connected, timestamp: Date.now() }),
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
  // `tick` from the snapshot. The raw frame reaches the hindbrain through the
  // event queue regardless, so nothing here needs to narrate it.
  return {
    category: { _tag: "StateChange" },
    stateUpdate: (prev) => {
      const s = prev as GameState
      return { ...s, inCombat: true, tick: payload.tick, timestamp: Date.now() }
    },
  }
}

function handleBattleDamage(payload: NotificationBattleDamage): EventResult {
  return {
    category: { _tag: "StateChange" },
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
 * Maps the frames the `@spacemolt/lib` adapter puts on the queue —
 * `TYPED_NOTIFICATION_TYPES` pushes plus the host's own `state_sync` /
 * `connection_state` — onto the domain's `EventResult`. The loop consumes
 * `stateUpdate` (feeding the situation classifier, the state renderer and the
 * digest) and `context`; `category` is set for interface correctness.
 *
 * `logged_in` is deliberately absent: the library consumes that frame
 * internally to complete authentication and never emits it to `onAny`
 * (`account.ts` `routeFrame`). `full_state` is absent because it never existed
 * on the wire — it was minted locally by the 45-second poll this rebuild
 * deleted.
 */
export const spaceMoltEventProcessor: EventProcessor = {
  processEvent(event, _currentState) {
    const smEvent = event as GameEvent
    switch (smEvent.type) {
      case STATE_SYNC_FRAME:
        return handleStateSync((smEvent.payload ?? {}) as StateSyncPayload)

      case CONNECTION_STATE_FRAME:
        return handleConnectionState((smEvent.payload ?? {}) as { connected?: unknown })

      case "observation_update":
        return handleObservationUpdate(smEvent.payload as NotificationObservationUpdate)

      case "battle_update":
        return handleBattleUpdate(smEvent.payload as NotificationBattleUpdate)

      case "battle_damage":
        return handleBattleDamage(smEvent.payload as NotificationBattleDamage)

      case "player_died":
        return {
          category: { _tag: "LifecycleReset", reason: "player_died" },
          stateUpdate: (prev) => {
            const s = prev as GameState
            return { ...s, inCombat: false, timestamp: Date.now() }
          },
        }

      case "chat_message":
        return handleChatMessage(smEvent.payload as NotificationChatMessage)

      case "mining_yield":
        return handleMiningYield(smEvent.payload as NotificationMiningYield)

      // Logging handled externally; preserve a no-op log fn (matches old behavior).
      case "error":
      case "action_error":
        return { log: () => {} }

      default:
        // Every other typed notification, every control frame, and every
        // unknown/future frame. The host takes no state action — but the raw
        // frame still reaches the hindbrain through the event queue, which is
        // where it is appraised. Never throws.
        return {}
    }
  },
}

/** Layer providing the SpaceMolt event processor as the EventProcessor service. */
export const SpaceMoltEventProcessorLive = Layer.succeed(EventProcessorTag, spaceMoltEventProcessor)
