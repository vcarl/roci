import { Context, Effect, Layer, Queue, Scope, Fiber } from "effect"
import * as path from "node:path"
import { createSocket } from "@spacemolt/client-v2"
import type { WebSocketCtor } from "@spacemolt/client-v2"
import type { GameState, PlayerState, ShipState, SystemState, PoiState } from "./types.js"
import type { GameEvent, LoggedInPayload } from "./ws-types.js"
import { readPlayerCredentials, spaceMoltSocketBaseUrl } from "./session.js"
import { CharacterLog } from "@roci/core/logging/log-writer.js"
import { eventBase } from "@roci/core/logging/events.js"
import type { CharacterConfig } from "@roci/core/services/CharacterFs.js"

const QUEUE_CAPACITY = 500

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
     * The library owns the wire protocol and reconnect; this wrapper just
     * forwards `ServerEvent` frames into an Effect Queue and snapshots the
     * handshake (welcome + logged_in) into the initial game state.
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
    nearby: [],
    notifications: [],
    travelProgress: null,
    inCombat: false,
    tick: initialTick,
    timestamp: Date.now(),
  }
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

          yield* emitWs("system", `Connecting to ${spaceMoltSocketBaseUrl()} as ${creds.username}...`)

          // The `ws` package supplies the Node WebSocket implementation.
          const WebSocketImpl = yield* Effect.tryPromise({
            try: () => import("ws").then((m) => m.default),
            catch: (e) => new GameSocketError("Failed to load ws", e),
          })

          // createSocket resolves AFTER the handshake (welcome -> login ->
          // logged_in). The library auto-reconnects internally afterward.
          const socket = yield* Effect.tryPromise({
            try: () =>
              createSocket({
                auth: { username: creds.username, password: creds.password },
                baseUrl: spaceMoltSocketBaseUrl(),
                endpoint: "v1",
                WebSocketImpl: WebSocketImpl as unknown as WebSocketCtor,
              }),
            catch: (e) => new GameSocketError("Failed to open game socket", e),
          })

          // Single shared iterator over the socket's event queue. Every frame —
          // including the buffered `welcome`/`logged_in` — is delivered here in
          // order. We reuse this ONE iterator for both the handshake pre-loop
          // and the forwarding fiber so frames are never split across iterators.
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

          // Forward the buffered handshake frames so the event-processor /
          // hindbrain observe them in order before any live frame.
          yield* Effect.forEach(
            handshake.buffered,
            (frame) =>
              Queue.offer(events, frame).pipe(
                Effect.catchAll(() =>
                  emitWs("error", `Event queue full — dropping ${frame.type} event`),
                ),
              ),
            { discard: true },
          )

          const { initialState, tickIntervalSec, initialTick } = handshake

          yield* emitWs(
            "system",
            `Logged in as ${initialState.player.username} in ${
              initialState.system?.name ?? initialState.player.current_system
            } (tick_rate=${tickIntervalSec}s)`,
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

          // --- Forwarding fiber: pump live frames into the Queue. ---
          const forwardFiber = yield* Effect.gen(function* () {
            for (;;) {
              const next = yield* Effect.tryPromise(() => it.next())
              if (next.done) break
              yield* Queue.offer(events, next.value).pipe(
                Effect.catchAll(() =>
                  emitWs("error", `Event queue full — dropping ${next.value.type} event`),
                ),
              )
            }
          }).pipe(
            Effect.catchAll(() => Effect.void),
            Effect.forkScoped,
          )

          // Scope finalizer: stop forwarding, close the socket, drain the Queue.
          yield* Scope.addFinalizer(
            yield* Effect.scope,
            Effect.gen(function* () {
              yield* Fiber.interrupt(forwardFiber).pipe(Effect.catchAll(() => Effect.void))
              yield* Effect.tryPromise(() => socket.close()).pipe(
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
