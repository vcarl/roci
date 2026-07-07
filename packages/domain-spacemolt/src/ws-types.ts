/**
 * SpaceMolt event vocabulary — now a thin seam over `@spacemolt/client-v2`.
 *
 * The domain previously hand-rolled its own WebSocket event interfaces and a
 * `parseGameEvent` JSON parser for the raw `ws` connection. The client-v2
 * library now owns the wire protocol: `createSocket` yields a typed
 * `ServerEvent` discriminated union and never hands us raw strings, so the
 * parser is gone. This module re-exports the library's socket types under the
 * names the rest of the domain already uses (`GameEvent`) plus the individual
 * notification payload types the event-processor maps.
 *
 * Server -> client frames are identical across the library's `v1`/`v2`
 * endpoints; only outbound framing differs (we use `v1`, the default).
 */

import type { ServerEvent, NotificationBattleDamage } from "@spacemolt/client-v2"
import type { Behavior } from "@roci/core/logging/behavior.js"

/**
 * The domain's event type. The client-v2 `ServerEvent` closed discriminated
 * union — control frames (`welcome`, `logged_in`, `registered`, `ok`, `result`,
 * `error`, `action_result`, `action_error`) plus notifications (`battle_update`,
 * `player_died`, `scan_detected`, `pilotless_ship`, `reconnected`,
 * `mining_yield`, `chat_message`, `trade_offer_received`, `skill_level_up`,
 * `market_update`, `observation_update`, `crafting_update`) — PLUS one bridged
 * member (`battle_damage`) the lib doesn't yet type (see below).
 *
 * Unknown / future frame types are still delivered at runtime but fall outside
 * the lib's union — every such frame trips schema-gap discovery (see
 * `schemaGapNote`) and, if unhandled here, is a no-op `default:` case.
 *
 * TEMPORARY BRIDGE: `battle_damage` is a real WS push (it rides the default-on
 * "battle" notification channels — see the lib's `mute_notifications` docs) that
 * client-v2's hand-written `ServerEvent` union OMITS. We add it here so the
 * event-processor can handle per-hit damage as a first-class TYPED case. Remove
 * this member once client-v2's `ServerEvent` models `battle_damage` upstream —
 * the schema-gap discovery `note` firing for `battle_damage` (it's deliberately
 * kept OUT of `KNOWN_SERVER_EVENT_TYPES`) is the signal it hasn't yet.
 */
export type GameEvent =
  | ServerEvent
  | { type: "battle_damage"; payload: NotificationBattleDamage }

/**
 * The `type` strings of every member of the LIB's `ServerEvent` union — the
 * upstream source of truth for schema-gap discovery. Keep in sync with the
 * lib's `ServerEvent` union (`socket-types.d.ts`); a WS frame whose `type` is
 * NOT in this set is a hole in the client-v2/OpenAPI schema.
 *
 * NOTE: `battle_damage` is deliberately EXCLUDED even though `GameEvent` above
 * bridges it — this set represents what the LIB types, and the omission is the
 * signal (a fired `note`) that our bridge is still needed.
 */
export const KNOWN_SERVER_EVENT_TYPES: ReadonlySet<string> = new Set([
  "welcome",
  "logged_in",
  "registered",
  "ok",
  "result",
  "error",
  "action_result",
  "action_error",
  "battle_update",
  "player_died",
  "scan_detected",
  "pilotless_ship",
  "reconnected",
  "mining_yield",
  "chat_message",
  "trade_offer_received",
  "skill_level_up",
  "market_update",
  "observation_update",
  "crafting_update",
])

/**
 * Returns a schema-gap `note` behavior for a frame the lib's `ServerEvent` union
 * doesn't model, else null. Carries the full raw frame so the gap can be
 * reconciled into the client-v2/OpenAPI schema. No dedup — every untyped frame
 * emits a note, so QA/dev surfaces gaps to fix upstream.
 */
export function schemaGapNote(frame: { type: string; payload?: unknown }): Behavior | null {
  if (KNOWN_SERVER_EVENT_TYPES.has(frame.type)) return null
  return {
    type: "note",
    label: "unknown_ws_frame",
    data: { type: frame.type, payload: frame.payload },
    severity: "warn",
  }
}

// Re-export the library socket types the domain consumes so callers import from
// one place (`./ws-types.js`) rather than reaching into the vendored package.
export type {
  ServerEvent,
  RawServerFrame,
  WelcomePayload,
  LoggedInPayload,
  RegisteredPayload,
  ErrorPayload,
} from "@spacemolt/client-v2"

// Notification payload types (generated from the OpenAPI spec), re-exported for
// the event-processor's per-frame handlers.
export type {
  NotificationBattleUpdate,
  NotificationBattleDamage,
  NotificationObservationUpdate,
  NotificationMiningYield,
  NotificationPlayerDied,
  NotificationChatMessage,
  NotificationMarketUpdate,
  NotificationScanDetected,
  NotificationSkillLevelUp,
  NotificationTradeOfferReceived,
  NotificationCraftingUpdate,
  NotificationPilotlessShip,
  NotificationReconnected,
} from "@spacemolt/client-v2"

// The canonical full-state snapshot returned by the `get_state` query (v2). Used
// by the periodic/on-reconnect full-state refresh (see game-socket-impl.ts) and
// its normalizer in the event-processor. Its shape differs from LoggedInPayload:
// player/ship carry a leaner field set and location (system/poi/docked) is split
// into a dedicated `location` object rather than top-level system/poi blobs.
export type { V2GameState } from "@spacemolt/client-v2"

/**
 * Synthetic frame type the host injects into the event queue carrying a
 * `get_state` result payload. NOT a server `ServerEvent` — it never crosses the
 * wire; the refresh fiber mints it locally so full-state reconciliation flows
 * through the same event-processor/stateUpdate path as real frames.
 */
export const FULL_STATE_FRAME = "full_state" as const
