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
 * (`combat_update`, `player_died`, `scan_result`, `scan_detected`,
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
  NotificationCombatUpdate,
  NotificationObservationUpdate,
  NotificationMiningYield,
  NotificationPlayerDied,
  NotificationChatMessage,
  NotificationMarketUpdate,
  NotificationScanResult,
  NotificationScanDetected,
  NotificationSkillLevelUp,
  NotificationTradeOfferReceived,
  NotificationCraftingUpdate,
  NotificationPilotlessShip,
  NotificationReconnected,
} from "@spacemolt/client-v2"
