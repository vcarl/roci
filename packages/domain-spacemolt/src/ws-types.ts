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

import type { ServerEvent } from "@spacemolt/client-v2"

/**
 * The domain's event type. Identical to the client-v2 `ServerEvent` closed
 * discriminated union: control frames (`welcome`, `logged_in`, `registered`,
 * `ok`, `result`, `error`, `action_result`, `action_error`) plus notifications
 * (`battle_update`, `player_died`, `scan_detected`,
 * `pilotless_ship`, `reconnected`, `mining_yield`, `chat_message`,
 * `trade_offer_received`, `skill_level_up`, `market_update`,
 * `observation_update`, `crafting_update`).
 *
 * Unknown / future frame types are still delivered at runtime but fall outside
 * this union — handle them in a `default:` branch as `RawServerFrame`.
 */
export type GameEvent = ServerEvent

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
