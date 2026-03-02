import { Context, Effect, Layer, Queue, Scope, Schedule, Fiber, Ref, Deferred } from "effect"
import WebSocket from "ws"
import type { Credentials, GameState, NearbyPlayer, PlayerState, ShipState } from "./types.js"
import type {
  GameEvent,
  LoggedInEvent,
  WelcomeEvent,
} from "./ws-types.js"
import { parseGameEvent } from "./ws-types.js"
import { tag } from "../../logging/console-renderer.js"

const WS_URL = "wss://game.spacemolt.com/ws"
const HEALTH_URL = "https://game.spacemolt.com/health"
const RECONNECT_DELAY_MS = 2000
const QUEUE_CAPACITY = 500
const POLL_INTERVAL_MS = 10_000

/** Fetch the current game tick from the health endpoint. Returns null on failure. */
async function fetchHealthTick(): Promise<number | null> {
  try {
    const resp = await fetch(HEALTH_URL)
    const data = (await resp.json()) as { tick?: number }
    return data.tick ?? null
  } catch {
    return null
  }
}

export class GameSocketError {
  readonly _tag = "GameSocketError"
  constructor(readonly message: string, readonly cause?: unknown) {}
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
     * Open a WebSocket connection, authenticate, and start receiving events.
     * Scoped — the connection is closed when the scope finalizes.
     * Each call creates an independent connection with its own WebSocket and event queue.
     * Returns the event queue and initial state from login.
     */
    readonly connect: (
      creds: Credentials,
      characterName: string,
    ) => Effect.Effect<GameSocketConnection, GameSocketError, Scope.Scope>
  }
>() {}

/**
 * Build a GameState from the logged_in event payload.
 * The WS logged_in doesn't include everything that collectGameState does,
 * but it gives us the core state to start from.
 */
function buildInitialState(payload: LoggedInEvent["payload"]): GameState {
  return {
    player: payload.player,
    ship: payload.ship,
    poi: payload.poi,
    system: payload.system,
    cargo: payload.ship.cargo,
    nearby: [],
    notifications: [],
    travelProgress: null,
    inCombat: false,
    tick: 0,
    timestamp: Date.now(),
  }
}

export const makeGameSocketLive = () =>
  Layer.succeed(
    GameSocket,
    GameSocket.of({
      connect: (creds, characterName) =>
        Effect.gen(function* () {
          const events = yield* Queue.bounded<GameEvent>(QUEUE_CAPACITY)

          // Per-connection WebSocket reference (not shared across connections)
          let ws: WebSocket | null = null

          // Deferred that resolves with initial state once logged_in arrives
          const loggedInDeferred = yield* Deferred.make<GameState, GameSocketError>()

          // Track whether we've logged in at least once
          const hasLoggedIn = yield* Ref.make(false)

          // Tick interval from welcome event (seconds per tick)
          const tickIntervalRef = yield* Ref.make(1) // default 1s per tick until welcome arrives

          // Flag to stop reconnect loop on finalization
          const closed = yield* Ref.make(false)

          // Poll state — shared between message handler and poll fiber
          let pollPending = false
          let serverTick = 0 // Synced from /health endpoint

          const connectAndLogin = Effect.gen(function* () {
            yield* Effect.sync(() =>
              console.log(`${tag(characterName, "ws")} Connecting to ${WS_URL}...`),
            )

            const socket = yield* Effect.async<WebSocket, GameSocketError>((resume) => {
              const sock = new WebSocket(WS_URL)

              sock.on("open", () => {
                resume(Effect.succeed(sock))
              })

              sock.on("error", (err) => {
                resume(Effect.fail(new GameSocketError("WebSocket connection failed", err)))
              })
            })

            ws = socket

            // Set up message handler
            socket.on("message", (data) => {
              const raw = data.toString()
              // Server may send multiple JSON objects in one WS frame (newline-delimited)
              const chunks = raw.split("\n").filter((s) => s.trim().length > 0)
              for (const chunk of chunks) {
                try {
                  const event = parseGameEvent(chunk)

                  // If this is the logged_in event, resolve the deferred
                  if (event.type === "logged_in") {
                    const state = buildInitialState((event as LoggedInEvent).payload)
                    Effect.runSync(
                      Deferred.succeed(loggedInDeferred, state).pipe(
                        Effect.catchAll(() => Effect.void), // Already resolved on reconnect
                      ),
                    )
                    Effect.runSync(Ref.set(hasLoggedIn, true))
                  }

                  // Synthesize state_update from get_status poll responses
                  if (event.type === "ok" && pollPending) {
                    const payload = (event as { type: "ok"; payload: Record<string, unknown> }).payload
                    if (payload.player && payload.ship) {
                      pollPending = false
                      const synthetic = {
                        type: "state_update" as const,
                        payload: {
                          tick: serverTick,
                          player: payload.player as PlayerState,
                          ship: payload.ship as ShipState,
                          nearby: (payload.nearby ?? []) as NearbyPlayer[],
                          in_combat: (payload.in_combat as boolean) ?? false,
                          ...(payload.travel_progress != null ? {
                            travel_progress: payload.travel_progress as number,
                            travel_destination: payload.travel_destination as string,
                            travel_type: payload.travel_type as "travel" | "jump",
                            travel_arrival_tick: payload.travel_arrival_tick as number,
                          } : {}),
                        },
                      }
                      Effect.runFork(
                        Queue.offer(events, synthetic).pipe(
                          Effect.catchAll(() =>
                            Effect.sync(() => console.warn(`[${characterName}:ws] Event queue full — dropping state_update event`))
                          ),
                        ),
                      )
                      return
                    }
                  }

                  // Offer original event to queue
                  Effect.runFork(
                    Queue.offer(events, event).pipe(
                      Effect.catchAll(() =>
                        Effect.sync(() => console.warn(`[${characterName}:ws] Event queue full — dropping ${event.type} event`))
                      ),
                    ),
                  )
                } catch (err) {
                  console.error(`${tag(characterName, "ws")} Failed to parse message: ${err}`)
                }
              } // end for chunks
            })

            // Wait for welcome, then send login
            yield* Effect.async<void, GameSocketError>((resume) => {
              // Welcome should arrive quickly after connect
              const timeout = setTimeout(() => {
                resume(Effect.fail(new GameSocketError("Timed out waiting for welcome")))
              }, 10000)

              const handler = (data: WebSocket.Data) => {
                try {
                  const event = parseGameEvent(data.toString())
                  if (event.type === "welcome") {
                    clearTimeout(timeout)
                    socket.removeListener("message", handler)
                    const welcomePayload = (event as WelcomeEvent).payload
                    Effect.runSync(Ref.set(tickIntervalRef, welcomePayload.tick_rate))
                    serverTick = welcomePayload.current_tick
                    resume(Effect.succeed(undefined))
                  }
                } catch {
                  // ignore parse errors during welcome wait
                }
              }

              socket.on("message", handler)
            })

            const currentTickInterval = yield* Ref.get(tickIntervalRef)
            yield* Effect.sync(() =>
              console.log(`${tag(characterName, "ws")} Received welcome (tick_rate=${currentTickInterval}s), sending login...`),
            )

            // Send login
            yield* Effect.try({
              try: () =>
                socket.send(
                  JSON.stringify({
                    type: "login",
                    payload: { username: creds.username, password: creds.password },
                  }),
                ),
              catch: (e) => new GameSocketError("Failed to send login", e),
            })

            // Set up reconnect handler
            socket.on("close", () => {
              console.log(`${tag(characterName, "ws")} Connection closed`)
              ws = null

              // Reconnect if not intentionally closed
              Effect.runFork(
                Effect.gen(function* () {
                  const isClosed = yield* Ref.get(closed)
                  if (isClosed) return

                  yield* Effect.sync(() =>
                    console.log(
                      `${tag(characterName, "ws")} Reconnecting in ${RECONNECT_DELAY_MS}ms...`,
                    ),
                  )
                  yield* Effect.sleep(RECONNECT_DELAY_MS)

                  const stillClosed = yield* Ref.get(closed)
                  if (stillClosed) return

                  yield* connectAndLogin.pipe(
                    Effect.catchAll((e) =>
                      Effect.sync(() =>
                        console.error(
                          `${tag(characterName, "ws")} Reconnect failed: ${e.message}`,
                        ),
                      ),
                    ),
                  )
                }),
              )
            })

            socket.on("error", (err) => {
              console.error(`${tag(characterName, "ws")} Error: ${err.message}`)
            })
          })

          // Initial connection
          yield* connectAndLogin

          // Wait for login response
          const initialState = yield* Deferred.await(loggedInDeferred).pipe(
            Effect.timeoutFail({
              duration: "30 seconds",
              onTimeout: () => new GameSocketError("Timed out waiting for logged_in"),
            }),
          )

          yield* Effect.sync(() =>
            console.log(
              `${tag(characterName, "ws")} Logged in as ${initialState.player.username} in ${initialState.system?.name ?? initialState.player.current_system}`,
            ),
          )

          // Start polling fiber — sends get_status periodically to synthesize state_update events
          // The server doesn't push state_update to idle players, so we poll instead.
          // Fetches /health each cycle to sync the real game tick for synthetic events.
          const pollFiber = yield* Effect.gen(function* () {
            const tick = yield* Effect.tryPromise({
              try: () => fetchHealthTick(),
              catch: () => null,
            })
            if (tick != null) serverTick = tick

            yield* Effect.sync(() => {
              if (ws && ws.readyState === WebSocket.OPEN) {
                pollPending = true
                ws.send(JSON.stringify({ type: "get_status" }))
              }
            })
          }).pipe(
            Effect.repeat(Schedule.spaced(`${POLL_INTERVAL_MS} millis`)),
            Effect.catchAll(() => Effect.void),
            Effect.fork,
          )

          // Register finalizer to close the WebSocket and stop polling
          yield* Scope.addFinalizer(
            yield* Effect.scope,
            Effect.gen(function* () {
              yield* Ref.set(closed, true)
              yield* Fiber.interrupt(pollFiber).pipe(Effect.catchAll(() => Effect.void))
              yield* Effect.sync(() => {
                if (ws) {
                  ws.close()
                  ws = null
                }
              })
              yield* Queue.shutdown(events)
              yield* Effect.sync(() =>
                console.log(`${tag(characterName, "ws")} Connection closed (finalized)`),
              )
            }),
          )

          const tickIntervalSec = yield* Ref.get(tickIntervalRef)
          return { events, initialState, tickIntervalSec, initialTick: serverTick }
        }),
    }),
  )
