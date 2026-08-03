/**
 * The domain's frame vocabulary, over `@spacemolt/lib` 12.0.0.
 *
 * Replaces `ws-types.ts`, whose whole job was compensating for
 * `@spacemolt/client-v2`'s hand-written `ServerEvent` union: a 20-entry
 * `KNOWN_SERVER_EVENT_TYPES` set kept in sync by hand, plus a hand-bridged
 * `battle_damage` member for a real, default-on push frame the union omitted.
 * `@spacemolt/lib` generates `TYPED_NOTIFICATION_TYPES` (36 entries) from the
 * server's published OpenAPI spec, so both hacks collapse into one import — and
 * `battle_started` / `battle_joined` / `battle_ended` / `battle_alert` /
 * `player_kill` / `base_raid_update`, which used to arrive as untyped frames
 * that tripped a schema-gap note and then hit a no-op `default:`, are typed.
 */

import { TYPED_NOTIFICATION_TYPES } from "@spacemolt/lib"
import type { Behavior } from "@roci/core/logging/behavior.js"

/**
 * The domain's event type: whatever came off the wire, plus the host's own
 * synthetic frames. Structurally `RawFrame` (`@spacemolt/lib`'s `protocol.ts`)
 * minus `request_id`, which nothing in this domain reads.
 *
 * Deliberately NOT a discriminated union. The library's `NotificationFrame`
 * union covers only the 36 types with a published schema; unknown/future pushes
 * are real and are delivered as raw frames. The event-processor switches on
 * `type` and casts each payload to its generated type — the same shape the
 * library's own `on<K>(type, handler)` overload provides — so a future frame is
 * a no-op `default:` rather than a type error.
 */
export interface GameEvent {
  readonly type: string
  readonly payload?: unknown
}

/**
 * Host-minted frame carrying a StateCache delta (see `account-socket.ts`).
 *
 * NOT the dead `full_state` frame. That one was a 45-second `get_state` poll
 * minting a ~9KB JSON dump the 2B provably could not read numbers out of. This
 * one is EDGE-driven — emitted only when the cache actually changed — and its
 * payload leads with the CHANGED SECTION NAMES followed by a translated partial
 * `GameState`, so the model reads a short list of words before any JSON.
 */
export const STATE_SYNC_FRAME = "state_sync" as const

/**
 * Host-minted frame carrying the socket's liveness, from the library's
 * `onDisconnected` / `onReconnecting` / `onReconnected` listeners.
 *
 * This is the replacement for the wall-clock staleness banner that died with
 * the poll (`situation.ts`'s deleted `STATE_STALE_WARN_MS`) — the character's
 * only signal that its worldview is frozen. It is a real connection state
 * rather than an inference from a stopwatch.
 */
export const CONNECTION_STATE_FRAME = "connection_state" as const

/** The frames the host itself mints. Never a schema gap — we wrote them. */
export const HOST_FRAME_TYPES: ReadonlySet<string> = new Set([
  STATE_SYNC_FRAME,
  CONNECTION_STATE_FRAME,
])

/**
 * Control-plane frames. The library consumes `welcome`, `registered` and the
 * authenticating `logged_in` internally (`account.ts` `routeFrame`) and never
 * emits them to `onAny`; the rest reach `onAny` when no pending request
 * correlates them. Listed in full anyway — a control frame is never a schema
 * gap, and which ones surface is the library's business, not ours.
 */
export const CONTROL_FRAME_TYPES: ReadonlySet<string> = new Set([
  "welcome",
  "logged_in",
  "registered",
  "ok",
  "result",
  "action_result",
  "action_error",
  "error",
])

/** Every frame type this domain considers modelled. */
export const KNOWN_FRAME_TYPES: ReadonlySet<string> = new Set([
  ...TYPED_NOTIFICATION_TYPES,
  ...CONTROL_FRAME_TYPES,
  ...HOST_FRAME_TYPES,
])

/**
 * Returns a schema-gap `note` behavior for a frame the library's GENERATED
 * notification catalog doesn't model, else null. Carries the full raw frame so
 * the gap can be reconciled upstream into the server's OpenAPI spec.
 *
 * NO DEDUP — every untyped frame emits a note. Deliberate: a repeated gap is a
 * repeated signal that the generated catalog is behind the server, and
 * suppressing repeats would hide exactly the frames arriving most often. This
 * is the repo's only early warning for schema drift; it is what caught
 * `battle_damage` against client-v2.
 */
export function schemaGapNote(frame: { type: string; payload?: unknown }): Behavior | null {
  if (KNOWN_FRAME_TYPES.has(frame.type)) return null
  return {
    type: "note",
    label: "unknown_ws_frame",
    data: { type: frame.type, payload: frame.payload },
    severity: "warn",
  }
}
