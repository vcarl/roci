import { Context, Effect, Layer, Queue, Scope, Fiber, Ref, Deferred } from "effect"
import * as path from "node:path"
import { createSocket } from "@spacemolt/client-v2"
import type { WebSocketCtor, SpacemoltSocket } from "@spacemolt/client-v2"
import type { GameState, PlayerState, ShipState, SystemState, PoiState } from "./types.js"
import type { GameEvent, LoggedInPayload } from "./ws-types.js"
import { FULL_STATE_FRAME, schemaGapNote } from "./ws-types.js"
import { readPlayerCredentials, spaceMoltSocketBaseUrl, spaceMoltUserAgent } from "./session.js"
import { makeStateRefreshLoop } from "./state-refresh.js"
import { reconnectWithBackoff, DEFAULT_BACKOFF, type BackoffPolicy } from "./reconnect.js"
import { CharacterLog, logBehavior } from "@roci/core/logging/log-writer.js"
import { eventBase } from "@roci/core/logging/events.js"
import type { CharacterConfig } from "@roci/core/services/CharacterFs.js"

const QUEUE_CAPACITY = 500

/**
 * How often to pull a full canonical player+ship snapshot via `get_state`. The
 * handshake `logged_in` is the only frame that carries full ship/cargo/dock
 * state; observation_update deltas never do. Without a periodic refresh, cargo,
 * fuel, hull and credits drift (esp. the optimistic mining_yield cargo bump) and
 * the state bar freezes. ~45s ≈ every 1–2 game ticks (tick_rate default 10–30s).
 */
const STATE_REFRESH_INTERVAL_MS = 45_000
/** Bound each get_state request so a stuck refresh can't wedge the refresh loop. */
const STATE_REFRESH_TIMEOUT_MS = 15_000

/**
 * Staleness ceiling for the refresh watchdog: if no SUCCESSFUL full-state
 * refresh lands within this window, the watchdog escalates loudly and forces a
 * HARD RECONNECT (the socket has silently died — half-open, or the library gave
 * up reconnecting). Default 2 intervals (90s) to shorten the blind spot before
 * recovery kicks in; overridable via `ROCI_SM_STATE_STALE_CEILING_MS`. Invalid /
 * non-positive values fall back to the default (mirrors resolveMaxRestarts).
 *
 * Note: a TERMINAL socket close is detected far faster than this — the library
 * ends its event queue, the forwarding loop's iterator returns `done`, and the
 * supervisor re-dials immediately. This ceiling only bounds the HALF-OPEN case,
 * where frames silently stop but the iterator never ends.
 */
const DEFAULT_STATE_STALE_CEILING_MS = 2 * STATE_REFRESH_INTERVAL_MS
export function resolveStateStaleCeilingMs(): number {
  const raw = process.env.ROCI_SM_STATE_STALE_CEILING_MS
  if (raw === undefined) return DEFAULT_STATE_STALE_CEILING_MS
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STATE_STALE_CEILING_MS
}

/** Hard-reconnect backoff: 1s → 2s → … → 30s cap, retrying indefinitely. */
const RECONNECT_POLICY: BackoffPolicy = DEFAULT_BACKOFF

export class GameSocketError {
  readonly _tag = "GameSocketError"
  constructor(readonly message: string, readonly cause?: unknown) {}
  toString() { return this.message }
}

export interface GameSocketConnection {
  /** Queue of incoming game events. Take from this in the event loop. */
  readonly events: Queue.Queue<GameEvent>
  /** Initial game state from the logged_in event. */
  readonly initialState: GameState
  /** Seconds per tick, from the server welcome event tick_rate field. */
  readonly tickIntervalSec: number
  /** Current game tick at connection time, from the server welcome event. */
  readonly initialTick: number
}

export class GameSocket extends Context.Tag("GameSocket")<
  GameSocket,
  {
    /**
     * Open a game socket via `@spacemolt/client-v2`, authenticate, and start
     * receiving events. Scoped — the connection is closed when the scope
     * finalizes. Each call creates an independent socket and event queue.
     *
     * The library owns the wire protocol and a transparent internal reconnect
     * for transient drops. This wrapper adds a DOMAIN-LAYER hard reconnect on
     * top: when the socket dies terminally (the library gives up) or goes
     * half-open (frames silently stop), the supervisor tears the dead socket
     * down and dials a fresh one with capped exponential backoff, forever. The
     * `events` Queue and the `GameSocketConnection` handle stay stable across
     * reconnects — only the underlying socket is swapped.
     */
    readonly connect: (
      char: CharacterConfig,
    ) => Effect.Effect<GameSocketConnection, GameSocketError, Scope.Scope | CharacterLog>
  }
>() {}

/**
 * Build a GameState from the logged_in payload. The handshake doesn't carry
 * everything collectGameState gathers, but it gives the core state to start.
 */
function buildInitialState(payload: LoggedInPayload, initialTick: number): GameState {
  const ship = payload.ship as unknown as ShipState
  return {
    player: payload.player as unknown as PlayerState,
    ship,
    system: payload.system as unknown as SystemState,
    poi: (payload.poi ?? null) as unknown as PoiState | null,
    cargo: (payload.ship as { cargo?: ShipState["cargo"] }).cargo ?? [],
    // Incoming trade offers from the handshake — drives the `pending_trades`
    // interrupt via hasPendingTrades. Only refreshed on re-login (see the
    // staleness note on loggedInToSnapshot in event-processor.ts).
    pendingTrades: (payload.pending_trades ?? []) as unknown as GameState["pendingTrades"],
    nearby: [],
    notifications: [],
    travelProgress: null,
    inCombat: false,
    tick: initialTick,
    timestamp: Date.now(),
    lastFullStateAt: Date.now(),
  }
}

/**
 * One live socket generation: the socket handle plus the SINGLE async iterator
 * that drains its event queue. The library's iterators all share one queue, so
 * we must create exactly one per socket and reuse it for both the handshake
 * drain and the forwarding loop — a second iterator would steal frames.
 */
interface OpenConnection {
  readonly socket: SpacemoltSocket
  readonly it: AsyncIterator<GameEvent>
  readonly tickIntervalSec: number
  readonly initialTick: number
  readonly initialState: GameState
  readonly buffered: GameEvent[]
}

export const makeGameSocketLive = () =>
  Layer.succeed(
    GameSocket,
    GameSocket.of({
      connect: (char) =>
        Effect.gen(function* () {
          const log = yield* CharacterLog
          const emitWs = (kind: "system" | "error", message: string) =>
            log.emit(char, {
              ...eventBase(char.name, "orchestrator", "ws"),
              kind,
              message,
            } as never).pipe(Effect.catchAll(() => Effect.void))

          // --- Credentials from the per-player session file (Phase-0 helper). ---
          // char.dir is <root>/players/<name>/me, so root is three levels up.
          const projectRoot = path.resolve(char.dir, "..", "..", "..")
          const creds = yield* Effect.try({
            try: () => readPlayerCredentials(projectRoot, char.name),
            catch: (e) =>
              new GameSocketError(
                `Failed to read credentials for "${char.name}"`,
                e,
              ),
          })

          const events = yield* Queue.bounded<GameEvent>(QUEUE_CAPACITY)

          // Forward one frame into the event queue, first tripping schema-gap
          // discovery: any frame whose `type` isn't a member of the lib's
          // `ServerEvent` union emits a `note` behavior (no dedup) so QA/dev can
          // reconcile the gap into the client-v2/OpenAPI schema upstream.
          const forwardFrame = (frame: GameEvent) =>
            Effect.gen(function* () {
              const note = schemaGapNote(frame)
              if (note) {
                yield* logBehavior(char.name, "orchestrator", "ws", note)
              }
              yield* Queue.offer(events, frame).pipe(
                Effect.catchAll(() =>
                  emitWs("error", `Event queue full — dropping ${frame.type} event`),
                ),
              )
            })

          // The `ws` package supplies the Node WebSocket implementation. Loaded
          // once and reused for every (re)dial.
          const WebSocketImpl = yield* Effect.tryPromise({
            try: () => import("ws").then((m) => m.default),
            catch: (e) => new GameSocketError("Failed to load ws", e),
          })

          // --- openConnection: dial + handshake + resubscribe. Reused for the
          // first connect AND every hard reconnect, so recovery re-authenticates
          // and re-subscribes exactly like a fresh start. ---
          const openConnection: Effect.Effect<OpenConnection, GameSocketError> =
            Effect.gen(function* () {
              yield* emitWs("system", `Connecting to ${spaceMoltSocketBaseUrl()} as ${creds.username}...`)

              // createSocket resolves AFTER the handshake (welcome -> login ->
              // logged_in). The library auto-reconnects internally afterward.
              const socket = yield* Effect.tryPromise({
                try: () =>
                  createSocket({
                    auth: { username: creds.username, password: creds.password },
                    baseUrl: spaceMoltSocketBaseUrl(),
                    endpoint: "v1",
                    WebSocketImpl: WebSocketImpl as unknown as WebSocketCtor,
                    // Identify the connection as roci on the WS handshake.
                    wsOptions: { headers: { "User-Agent": spaceMoltUserAgent() } },
                  }),
                catch: (e) => new GameSocketError("Failed to open game socket", e),
              })

              // Single shared iterator over the socket's event queue (see
              // OpenConnection docs). Reused for the handshake and forwarding.
              const it = socket[Symbol.asyncIterator]()

              // --- Handshake pre-loop: drain buffered welcome/logged_in. ---
              const handshake = yield* Effect.tryPromise({
                try: async () => {
                  let tickIntervalSec = 10
                  let initialTick = 0
                  let initialState: GameState | null = null
                  const buffered: GameEvent[] = []
                  for (;;) {
                    const { value, done } = await it.next()
                    if (done) break
                    buffered.push(value)
                    if (value.type === "welcome") {
                      tickIntervalSec = value.payload.tick_rate ?? 10
                      initialTick = value.payload.current_tick ?? 0
                    } else if (value.type === "logged_in") {
                      initialState = buildInitialState(value.payload, initialTick)
                      break
                    }
                  }
                  if (!initialState) {
                    throw new Error("socket closed before logged_in frame")
                  }
                  return { tickIntervalSec, initialTick, initialState, buffered }
                },
                catch: (e) => new GameSocketError("Failed during handshake", e),
              }).pipe(
                Effect.timeoutFail({
                  duration: "30 seconds",
                  onTimeout: () => new GameSocketError("Timed out waiting for logged_in"),
                }),
              )

              yield* emitWs(
                "system",
                `Logged in as ${handshake.initialState.player.username} in ${
                  handshake.initialState.system?.name ?? handshake.initialState.player.current_system
                } (tick_rate=${handshake.tickIntervalSec}s)`,
              )

              // Ask the server to push observation_update frames. Best-effort.
              yield* Effect.try({
                try: () => socket.subscribeObservation(),
                catch: (e) => e,
              }).pipe(
                Effect.catchAll(() =>
                  emitWs("error", "Failed to subscribe to observation updates"),
                ),
              )

              return { socket, it, ...handshake }
            })

          // First connection. `currentConn` is the mutable pointer the refresh
          // loop and forwarding supervisor read; the supervisor swaps it on each
          // hard reconnect. Reads of a captured `let` inside an Effect always see
          // the latest value.
          let currentConn = yield* openConnection

          // Forward the initial handshake frames so the event-processor /
          // hindbrain observe them in order before any live frame.
          yield* Effect.forEach(currentConn.buffered, forwardFrame, { discard: true })

          const { initialState, tickIntervalSec, initialTick } = currentConn

          // --- Full-state refresh ---
          // The handshake `logged_in` is the ONLY frame that carries full
          // ship/cargo/dock/credits state; observation_update deltas never do.
          // So pull a canonical `get_state` snapshot periodically and right after
          // a reconnect, injecting it as a synthetic `full_state` frame so it
          // reconciles through the same event-processor/stateUpdate path.
          //
          // Reads the CURRENT socket each run so it follows hard reconnects.
          const performRefresh = Effect.gen(function* () {
            const socket = currentConn.socket
            const resp = yield* Effect.tryPromise({
              try: () => socket.request({ type: "get_state" }, { timeoutMs: STATE_REFRESH_TIMEOUT_MS }),
              catch: (e) => new GameSocketError("get_state refresh failed", e),
            })
            if (resp.type === "error" || resp.type === "action_error") {
              // Terminal error frame — keep the last snapshot, never clobber.
              yield* emitWs(
                "error",
                `get_state refresh error: ${(resp.payload as { message?: string })?.message ?? resp.type}`,
              )
              return false
            }
            // Synthetic host frame (outside the ServerEvent union) — cast to enqueue.
            const frame = {
              type: FULL_STATE_FRAME,
              payload: (resp as { payload?: Record<string, unknown> }).payload ?? {},
            } as unknown as GameEvent
            const offered = yield* Queue.offer(events, frame).pipe(Effect.as(true)).pipe(
              Effect.catchAll(() =>
                emitWs("error", "Event queue full — dropping full_state refresh").pipe(Effect.as(false)),
              ),
            )
            return offered
          }).pipe(
            // A failed refresh must never zero state — log and keep the last snapshot.
            Effect.catchAll((e) =>
              emitWs("error", `State refresh failed: ${String(e)}`).pipe(Effect.as(false)),
            ),
          )

          // Latch the forwarding supervisor watches to abandon the current
          // iterator and hard-reconnect. The staleness watchdog completes it when
          // a half-open socket stops delivering frames but never ends its
          // iterator; a terminal close is handled by iterator-`done` instead.
          const redialSignalRef = yield* Ref.make<Deferred.Deferred<void> | null>(null)

          // Supervise refresh timing, the skip-if-busy latch, and staleness. The
          // logic lives in state-refresh.ts with injected deps so it's unit-tested.
          // onStale FORCES a hard reconnect (not a re-poll of the dead socket).
          const refreshLoop = yield* makeStateRefreshLoop({
            performRefresh,
            emit: emitWs,
            status: () => currentConn.socket.status,
            intervalMs: STATE_REFRESH_INTERVAL_MS,
            timeoutMs: STATE_REFRESH_TIMEOUT_MS,
            staleCeilingMs: resolveStateStaleCeilingMs(),
            onStale: Effect.gen(function* () {
              const sig = yield* Ref.get(redialSignalRef)
              if (sig) yield* Deferred.succeed(sig, undefined as void)
            }),
          })
          const refreshOnce = refreshLoop.refreshOnce

          // Signals the finalizer has run so the supervisor stops re-dialing.
          const closing = { done: false }

          // --- Forwarding supervisor: pump live frames into the Queue, and hard
          // reconnect when the current socket dies (iterator `done`) or goes
          // half-open (staleness watchdog completes the redial signal). ---
          const forwardFiber = yield* Effect.gen(function* () {
            for (;;) {
              if (closing.done) break
              const conn = currentConn
              const it = conn.it
              const redialSignal = yield* Deferred.make<void>()
              yield* Ref.set(redialSignalRef, redialSignal)

              // Drain this generation until the iterator ends or staleness fires.
              for (;;) {
                const step = yield* Effect.raceFirst(
                  Effect.tryPromise(() => it.next()).pipe(
                    Effect.map((n) => ({ kind: "frame" as const, n })),
                    Effect.catchAll(() =>
                      Effect.succeed({
                        kind: "frame" as const,
                        n: { done: true, value: undefined } as IteratorResult<GameEvent>,
                      }),
                    ),
                  ),
                  Deferred.await(redialSignal).pipe(Effect.as({ kind: "redial" as const })),
                )
                if (step.kind === "redial") break
                if (step.n.done) break
                yield* forwardFrame(step.n.value)
                // The library reconnects transparently and does NOT re-emit
                // logged_in, so refresh full state on the server's `reconnected`
                // frame. Fork so forwarding never blocks on the round-trip.
                if (step.n.value.type === "reconnected") {
                  yield* Effect.fork(refreshOnce)
                }
              }

              if (closing.done) break

              // Hard reconnect: tear the dead socket down, dial a fresh one with
              // capped exponential backoff (indefinite), re-auth + re-subscribe.
              yield* emitWs("error", "Live feed lost — reconnecting…")
              const next = yield* reconnectWithBackoff<OpenConnection>(conn, {
                teardown: (c) =>
                  Effect.tryPromise(() => c.socket.close()).pipe(
                    // A dead-TCP close can hang; bound it so redial isn't blocked.
                    Effect.timeout("2 seconds"),
                    Effect.catchAll(() => Effect.void),
                  ),
                dial: openConnection,
                emit: emitWs,
                policy: RECONNECT_POLICY,
              })
              currentConn = next
              // Reconcile fresh state immediately from the reconnect handshake…
              yield* Effect.forEach(next.buffered, forwardFrame, { discard: true })
              // …and pull a canonical get_state so the staleness watchdog's
              // lastOkAt resets (buffered logged_in doesn't touch its Ref).
              yield* Effect.fork(refreshOnce)
            }
          }).pipe(
            Effect.catchAll(() => Effect.void),
            Effect.forkScoped,
          )

          // --- Periodic refresh + staleness watchdog (scoped: interrupted on
          // connection close). runPeriodic pulls fresh state on a cadence;
          // runWatchdog notices if that flow silently wedges and forces recovery. ---
          yield* refreshLoop.runPeriodic.pipe(Effect.forkScoped)
          yield* refreshLoop.runWatchdog.pipe(Effect.forkScoped)

          // Scope finalizer: stop forwarding/reconnecting, close the socket, drain.
          yield* Scope.addFinalizer(
            yield* Effect.scope,
            Effect.gen(function* () {
              closing.done = true
              yield* Fiber.interrupt(forwardFiber).pipe(Effect.catchAll(() => Effect.void))
              yield* Effect.tryPromise(() => currentConn.socket.close()).pipe(
                Effect.catchAll(() => Effect.void),
              )
              yield* Queue.shutdown(events)
              yield* emitWs("system", "Connection closed (finalized)")
            }),
          )

          return { events, initialState, tickIntervalSec, initialTick }
        }),
    }),
  )
