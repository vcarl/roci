import { Context, Effect, Layer, Queue, Runtime, Scope } from "effect"
import * as path from "node:path"
import { Account } from "@spacemolt/lib"
import type {
  ConnectionClosedError,
  GameState as LibGameState,
  RawFrame,
  StateSection,
} from "@spacemolt/lib"
import type { GameState } from "./types.js"
import type { GameEvent } from "./game-events.js"
import { CONNECTION_STATE_FRAME, STATE_SYNC_FRAME, schemaGapNote } from "./game-events.js"
import { libStateToSnapshot, locationIdentity, type FullStateSnapshot } from "./lib-state.js"
import { readPlayerCredentials, spaceMoltWsUrl } from "./session.js"
import { CharacterLog, logBehavior } from "@roci/core/logging/log-writer.js"
import { eventBase } from "@roci/core/logging/events.js"
import type { CharacterConfig } from "@roci/core/services/CharacterFs.js"

const QUEUE_CAPACITY = 500

/**
 * Coalescing window for a state resync. A burst of combat frames must produce
 * ONE `get_status`, not one per hit.
 */
export const RESYNC_DEBOUNCE_MS = 2_000

/**
 * Idle reconciliation ceiling — the ONLY timer left in this module, and it is
 * not the poll this rebuild deleted.
 *
 * The poll that died fetched the world every 45s because the wire carried no
 * full state at all. The `StateCache` fixes that for everything the SERVER
 * pushes. What it cannot fix is §2's other channel: the character acts over the
 * REST `spacemolt` CLI inside the container, on an entirely independent session
 * this `Account` never sees. Most REST actions do push a notification back to
 * the player's socket (`mining_yield`, the battle family, `skill_level_up`,
 * `crafting_update`, the trade family) and those are handled edge-wise by
 * `RESYNC_TRIGGER_TYPES`; travel and jump surface as an `observation_update`
 * whose `poi_id`/`system_id` moved, also handled edge-wise. But `dock`,
 * `undock`, `refuel`, `repair`, `buy` and `sell` push the actor nothing — so
 * without a floor, a docked character that refuels sees its own fuel gauge
 * frozen at 6% for the rest of the session.
 *
 * 120s ≈ 12 game ticks, and it is a RECONCILIATION **CHECK** interval, not the
 * state channel and not a resurrected poll. Firing it calls `refresh()`
 * (`get_status`), but `StateCache.copySection` reports a section as "changed"
 * by PRESENCE in the response, not by diffing values — so every refresh
 * reports all 8 sections changed whether or not anything actually moved. The
 * `onStateChange` sink (below) is what turns that into an actual `state_sync`
 * emission or not: it fingerprints the translated snapshot and only mints a
 * frame when the fingerprint differs from the last one emitted
 * (`snapshotFingerprint`). Without that, this floor firing every 120s would BE
 * the dead 45s poll wearing a longer interval — an unconditional full-state
 * dump on a timer is exactly what this rebuild exists to delete.
 *
 * Set `ROCI_SM_RESYNC_IDLE_MS=0` to disable it outright; any other invalid /
 * non-positive value — including unset, blank/whitespace-only (routine in
 * shells and compose files), or a value that merely LOOKS like zero such as
 * `-0` — falls back to the default rather than silently disabling. Only the
 * literal `"0"` (after trimming) disables.
 */
const DEFAULT_RESYNC_IDLE_MS = 120_000
export function resolveResyncIdleMs(): number {
  const raw = process.env.ROCI_SM_RESYNC_IDLE_MS
  if (raw === undefined) return DEFAULT_RESYNC_IDLE_MS
  const trimmed = raw.trim()
  if (trimmed === "") return DEFAULT_RESYNC_IDLE_MS
  if (trimmed === "0") return 0
  const n = Number(trimmed)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RESYNC_IDLE_MS
}

/**
 * Notification types whose arrival means the PLAYER'S OWN ship, cargo, credits
 * or skills may have moved, so the cache is worth re-seeding.
 *
 * Deliberately EXCLUDES the high-frequency ambient pushes — `observation_update`
 * (arrives constantly; handled separately, and only when its poi/system moved),
 * `chat_message`, `market_update`, `battle_alert`, `scan_detected`,
 * `pirate_radio`, `player_kill`, `pilotless_ship`. Those are news about the
 * world, not evidence that your own numbers changed.
 */
export const RESYNC_TRIGGER_TYPES: ReadonlySet<string> = new Set([
  "mining_yield",
  "battle_started",
  "battle_joined",
  "battle_ended",
  "battle_damage",
  "battle_update",
  "player_died",
  "skill_level_up",
  "crafting_update",
  "trade_complete",
  "trade_declined",
  "trade_cancelled",
  "ship_commission_complete",
  "station_repaired",
  "achievement_unlocked",
  "base_destroyed",
  "base_raid_update",
  "facility_reclaimed",
  "drone_destroyed",
  "drone_update",
  "pirate_destroyed",
  "ranch_poached",
  "reconnected",
  "action_result",
])

export type ConnectionPhase = "connected" | "reconnecting" | "disconnected"

export class GameSocketError {
  readonly _tag = "GameSocketError"
  constructor(readonly message: string, readonly cause?: unknown) {}
  toString() { return this.message }
}

export interface GameSocketConnection {
  /** Queue of incoming game events. Take from this in the event loop. */
  readonly events: Queue.Queue<GameEvent>
  /** Initial game state, folded from the login-seeded StateCache. */
  readonly initialState: GameState
  /** Seconds per tick, from the server welcome frame's tick_rate. */
  readonly tickIntervalSec: number
  /** Current game tick at connection time, from the server welcome frame. */
  readonly initialTick: number
}

/**
 * Should an `onStateChange` firing become a `state_sync` frame?
 *
 * THE LIVE BUG THIS EXISTS FOR. `subscribeObservation()` makes the library
 * patch `location.nearby_players`/`nearby_player_count` into the base cache on
 * every observation push and fire `onStateChange(['location'])` for it
 * (`bridgeObservationToLocation`, `account.ts:787-795`). In the 2026-08-02
 * production probe, **8 of the 9 non-seed firings were bridge-only** — so a
 * consumer that trusts section-name membership emits a state frame on nearly
 * every observation push, for a "location change" that never happened.
 *
 * So: a firing whose ONLY changed section is `location` is emitted only when
 * `locationIdentity` (system|poi|docked_at) actually moved. Any other section —
 * `ship`, `cargo`, `player`, `modules`, `missions`, `queue`, `skills` — is real
 * news and always emits. Pure; total.
 */
export function shouldEmitStateSync(
  changed: ReadonlyArray<string>,
  prevIdentity: string,
  nextIdentity: string,
): boolean {
  if (changed.length === 0) return false
  const onlyLocation = changed.every((s) => s === "location")
  if (!onlyLocation) return true
  return prevIdentity !== nextIdentity
}

/**
 * Fingerprints the translated snapshot for cheap equality comparison — so the
 * `onStateChange` sink can detect a `get_status` reseed (the idle-floor
 * `refresh()`, or any `RESYNC_TRIGGER_TYPES`-driven one) that reported
 * sections "changed" by PRESENCE, not by value diff (`StateCache.copySection`),
 * without anything a consumer can actually see having moved. See
 * `DEFAULT_RESYNC_IDLE_MS`'s docblock for why this check exists at all.
 *
 * REVIEW HISTORY — three rounds, keep this the whole story:
 *
 * Round 1 hashed only `snapshot`. `FullStateSnapshot` deliberately never
 * carries `missions`/`queue` (Task 3, `lib-state.ts`), so a reseed reporting
 * `changed = ["missions"]` fingerprinted identical to the prior emission every
 * time and the frame was silently, permanently dropped — worse for missions
 * specifically because there is no `RESYNC_TRIGGER_TYPES` notification for
 * mission progress at all (checked the generated `TYPED_NOTIFICATION_TYPES`
 * catalog), so the idle floor was the ONLY path that would ever have caught
 * one.
 *
 * Round 2 "fixed" this by folding the RAW `missions`/`queue` cache sections
 * into the hash. That shipped a worse, Critical bug: `missions.active[].
 * expires_in_ticks` is a per-tick countdown (56422 in the live captured
 * snapshot) hashed verbatim, so it differs on essentially every 120s idle
 * check for the entire lifetime of any active mission — the exact
 * "unconditional poll in disguise" this guard exists to prevent, now scoped
 * to "whenever a mission is active" instead of "always". Not a narrow edge
 * case: missions are core gameplay.
 *
 * Round 3 (this version) asks the question both rounds stepped past: DOES a
 * missions/queue-only change reach the consumer at all if emitted? No.
 * `FullStateSnapshot` never carries the values regardless of whether a frame
 * fires, and nothing downstream reads the emitted frame's `sections` list
 * specially either — the only consumer today (`loop.ts`'s generic
 * `type: <t>\n${JSON.stringify(event)}` render) would show
 * `sections:["missions"]` beside a `snapshot` blob with no missions field at
 * all, and `event-digest.ts`'s `SNAPSHOT_EVENT_TYPES` doesn't even recognize
 * `"state_sync"` yet. So hashing missions/queue buys nothing observable today
 * and cost a Critical regression to provide it. Reverted to hashing ONLY
 * `translated` — missions/queue changes are invisible to this read path BY
 * CONSTRUCTION, full stop, until a later task carries them into `GameState`
 * for real (see the design-gap note in this task's report: `briefing.ts`
 * already renders `GameState.missions`/`activeMissions` with actionable
 * "Use complete_mission…" text, but the new `Account`-based
 * `initialGameState()` never populates either field — the real fix is
 * bigger than a dedupe hash and belongs in its own task, not bolted onto a
 * poll-suppression guard).
 *
 * A plain string comparison rather than a semantic deep-equal: cheap, and
 * sound here because `libStateToSnapshot` always builds the object the same
 * way, so two equal snapshots always serialize identically.
 */
export function snapshotFingerprint(snapshot: FullStateSnapshot): string {
  return JSON.stringify(snapshot)
}

/**
 * Whether an `observation_update` push means the character travelled or
 * jumped over the REST CLI — the ONLY signal this socket gets for that, since
 * the agent's action path is a separate session this `Account` never sees.
 * Compares the push's poi/system against the CACHE's own location (not the
 * previous push), so a stale cache — not merely a repeated push — is what
 * triggers a resync. Pure; total. `location` is `undefined` before the cache
 * has ever seeded a location section.
 */
export function shouldResyncOnObservation(
  payload: { poi_id?: string; system_id?: string } | undefined,
  location: { poi_id?: string; system_id?: string } | undefined,
): boolean {
  if (payload === undefined) return false
  return (
    (payload.poi_id !== undefined && payload.poi_id !== location?.poi_id) ||
    (payload.system_id !== undefined && payload.system_id !== location?.system_id)
  )
}

export interface ResyncScheduler {
  /** Request a resync; coalesces bursts within the debounce window. No-op once closed. */
  readonly schedule: () => void
  /** Stop scheduling and cancel any pending timer. Idempotent. */
  readonly close: () => void
}

/**
 * Debounced resync scheduler. A burst of combat frames (or the idle floor
 * firing mid-burst) must produce ONE `run()`, not one per trigger —
 * `schedule()` is a no-op while a timer is already pending. `run` is never
 * called after `close()`, including for a timer that was already pending when
 * `close()` fires: the connection is tearing down and `run` (which touches a
 * socket that may be mid-teardown) must not run against it. The timer is
 * `unref`'d so a pending debounce window never holds the process open at
 * exit.
 */
export function makeResyncScheduler(
  run: () => void,
  debounceMs: number = RESYNC_DEBOUNCE_MS,
): ResyncScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null
  let closed = false
  const schedule = (): void => {
    if (closed || timer !== null) return
    timer = setTimeout(() => {
      timer = null
      if (closed) return
      run()
    }, debounceMs)
    timer.unref?.()
  }
  const close = (): void => {
    closed = true
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
  return { schedule, close }
}

/**
 * The host-minted state frame. `sections` leads the payload deliberately: the
 * loop renders an event as `type: <t>\n<JSON.stringify(event)>`, so the 2B's
 * first tokens after the type line become a short list of English section names
 * rather than the opening brace of a blob. (The domain's STATUS digest is
 * composed in above the JSON on top of that — see `event-digest.ts`.)
 */
export function stateSyncFrame(
  changed: ReadonlyArray<string>,
  snapshot: FullStateSnapshot,
  tick: number,
): GameEvent {
  return { type: STATE_SYNC_FRAME, payload: { sections: [...changed], tick, snapshot } }
}

/** The host-minted liveness frame. Replaces the dead wall-clock staleness banner. */
export function connectionStateFrame(
  phase: ConnectionPhase,
  detail?: { attempt?: number; reason?: string },
): GameEvent {
  return {
    type: CONNECTION_STATE_FRAME,
    payload: {
      connected: phase === "connected",
      phase,
      ...(detail?.attempt !== undefined ? { attempt: detail.attempt } : {}),
      ...(detail?.reason !== undefined ? { reason: detail.reason } : {}),
    },
  }
}

/**
 * Build the loop's starting `GameState` from the login-seeded cache. Mirrors
 * the dead `buildInitialState` (`game-socket-impl.ts:95-115`) field for field,
 * except that everything now comes from the cache rather than from the
 * `logged_in` handshake payload — which the library consumes internally and
 * never emits (`account.ts` `routeFrame`, the `logged_in` case).
 */
export function initialGameState(snapshot: FullStateSnapshot, tick: number): GameState {
  return {
    player: snapshot.player as GameState["player"],
    ship: snapshot.ship as GameState["ship"],
    system: snapshot.system ?? null,
    poi: snapshot.poi ?? null,
    cargo: snapshot.cargo ?? [],
    nearby: [],
    inCombat: false,
    connected: true,
    combat: { lastEventTick: null, onsetSeq: 0 },
    deathPending: false,
    tick,
    timestamp: Date.now(),
  }
}

export class GameSocket extends Context.Tag("GameSocket")<
  GameSocket,
  {
    /**
     * Open an `@spacemolt/lib` `Account`, authenticate, subscribe to
     * observation, and start filling the event queue. Scoped — `close()` runs
     * when the scope finalizes. Each call creates an independent account and
     * queue.
     *
     * The library owns the wire protocol AND the reconnect loop: constructed
     * with `reconnect: true` plus a `credentials` provider, an unexpected drop
     * re-dials with capped backoff, re-authenticates and RE-SUBSCRIBES
     * (`reconnectOnce`, `account.ts:1103-1125`). There is no domain-layer
     * supervisor any more, and no staleness watchdog: liveness is reported
     * directly by `onDisconnected`/`onReconnecting`/`onReconnected` as
     * `connection_state` frames.
     */
    readonly connect: (
      char: CharacterConfig,
    ) => Effect.Effect<GameSocketConnection, GameSocketError, Scope.Scope | CharacterLog>
  }
>() {}

export const makeGameSocketLive = () =>
  Layer.succeed(
    GameSocket,
    GameSocket.of({
      connect: (char) =>
        Effect.gen(function* () {
          const log = yield* CharacterLog
          const runtime = yield* Effect.runtime<CharacterLog>()
          const runFork = Runtime.runFork(runtime)

          const emitWs = (kind: "system" | "error", message: string) =>
            log
              .emit(char, { ...eventBase(char.name, "orchestrator", "ws"), kind, message } as never)
              .pipe(Effect.catchAll(() => Effect.void))

          // char.root is <projectRoot>/players/<name>, so projectRoot is two up.
          const projectRoot = path.resolve(char.root, "..", "..")

          // A CLOSURE, not a one-shot credential object. The REST CLI rewrites
          // .spacemolt-session.json on every re-auth, so a long-lived socket
          // holding an in-memory password would fail to reconnect after a token
          // rotation. `reconnectOnce` calls this provider on every redial
          // (account.ts:1104), so each reconnect reads the file fresh.
          //
          // Auth needs NO translation layer: the session file's `username` and
          // `password` ARE what `{kind:'login'}` wants — verified against
          // production on 2026-08-02, first attempt, no error. Do NOT route
          // through the library's `FileCredentialStore`: it is a DIFFERENT,
          // incompatible persistence format (`{version:1, accounts:{[id]:{id,
          // credentials}}}`) and rejects roci's `version: 2` file outright. The
          // file's `session` sub-object (id/created_at/expires_at/player_id) is
          // the REST CLI's own HTTP bookkeeping and the library never reads it.
          // NOT annotated `(): AuthCredentials` — that widens the return to the
          // full union and loses the `.username` narrowing below (`AuthCredentials`
          // also has a `login_token`-kind member with no `username`). Letting TS
          // infer the literal `{kind:"login", ...}` type keeps `first.username`
          // sound while still structurally satisfying `Account`'s
          // `() => AuthCredentials | Promise<AuthCredentials>` option.
          const credentials = () => {
            const c = readPlayerCredentials(projectRoot, char.name)
            return { kind: "login" as const, username: c.username, password: c.password }
          }

          // Read once eagerly so a missing/malformed session file fails HERE,
          // with a clear error, rather than silently on the first reconnect.
          const first = yield* Effect.try({
            try: credentials,
            catch: (e) => new GameSocketError(`Failed to read credentials for "${char.name}"`, e),
          })

          const events = yield* Queue.bounded<GameEvent>(QUEUE_CAPACITY)

          // Teardown guard for `offer`, set the instant the finalizer starts —
          // BEFORE `Queue.shutdown` runs. `account.close()` is not guaranteed to
          // be synchronous all the way down (it suppresses reconnect and tears
          // down the socket, which may still deliver an in-flight frame), so
          // without this a frame arriving mid-teardown would hit
          // `Queue.unsafeOffer` on an already-shutdown queue and get logged as a
          // false "Event queue full" diagnosis instead of being silently dropped.
          let closing = false
          let lastIdentity = ""
          let lastSnapshotFingerprint: string | null = null
          let idleTimer: ReturnType<typeof setInterval> | null = null

          const offer = (frame: GameEvent): void => {
            if (closing) return
            if (!Queue.unsafeOffer(events, frame)) {
              runFork(emitWs("error", `Event queue full — dropping ${frame.type} event`))
            }
          }

          const url = spaceMoltWsUrl()
          yield* emitWs("system", `Connecting to ${url} as ${first.username}...`)

          const account = new Account({
            url,
            id: first.username,
            seedState: true,
            reconnect: true,
            credentials,
          })

          const resyncScheduler = makeResyncScheduler(() => {
            // `refresh()` re-seeds the cache from `get_status` and fires
            // `onStateChange` itself, so sink 2 does the emitting (and dedupes
            // against the last emitted snapshot — see `snapshotFingerprint`). A
            // failure must never zero state — log and keep the last snapshot.
            void account.refresh().catch((e: unknown) => {
              runFork(emitWs("error", `State resync failed: ${String(e)}`))
            })
          })

          // Register the finalizer IMMEDIATELY — the Account exists, and
          // everything from here on (the handshake's two awaited calls, the
          // seed check, or a fiber interruption at any later yield*) can fail
          // or be interrupted before the `Scope.addFinalizer` that used to sit
          // at the end of this function ever ran. A rejected auth — a rotated
          // password is the likely trigger — would then return without ever
          // calling `account.close()`: `userClosing` stays false, so
          // `shouldReconnect` is true and `maxRetries` defaults to `Infinity`.
          // The orphaned Account redials forever, holding listeners that offer
          // into a queue nobody shuts down — the exact "latches and never
          // recovers" failure class this rebuild exists to kill.
          yield* Scope.addFinalizer(
            yield* Effect.scope,
            Effect.gen(function* () {
              closing = true
              resyncScheduler.close()
              if (idleTimer !== null) clearInterval(idleTimer)
              yield* Effect.try({ try: () => account.close(), catch: (e) => e }).pipe(
                Effect.catchAll(() => Effect.void),
              )
              yield* Queue.shutdown(events)
              yield* emitWs("system", "Connection closed (finalized)")
            }),
          )

          // --- Sink 1: every server push frame, verbatim. -------------------
          // `onAny` receives notifications plus any control frame no pending
          // request correlated. Schema-gap discovery runs first, so a frame the
          // generated catalog does not model is reported before it is enqueued.
          account.onAny((frame: RawFrame) => {
            const note = schemaGapNote(frame)
            if (note) runFork(logBehavior(char.name, "orchestrator", "ws", note))
            offer({ type: frame.type, payload: frame.payload })

            if (RESYNC_TRIGGER_TYPES.has(frame.type)) {
              resyncScheduler.schedule()
              return
            }
            if (frame.type === "observation_update") {
              const p = frame.payload as { poi_id?: string; system_id?: string } | undefined
              if (shouldResyncOnObservation(p, account.location)) resyncScheduler.schedule()
            }
          })

          // --- Sink 2: state deltas, bridge-suppressed AND diff-deduped. ----
          // `shouldEmitStateSync` filters the observation-bridge's location-only
          // noise; `snapshotFingerprint` then filters the idle-floor/trigger
          // resync's "changed by presence, not by value" noise (see
          // `DEFAULT_RESYNC_IDLE_MS`). Both must pass for a frame to go out.
          // Fingerprints ONLY the translated snapshot (see `snapshotFingerprint`'s
          // docblock, "Round 3") — a missions/queue-only `changed` is real per
          // `shouldEmitStateSync`, but is currently invisible downstream by
          // construction (the snapshot never carries those values, and nothing
          // reads `sections` specially), so it correctly produces the SAME
          // fingerprint and is not re-emitted. A known, documented gap, not
          // a bug — see this task's report.
          account.onStateChange((changed: StateSection[]) => {
            const cache: Readonly<LibGameState> = account.state
            const nextIdentity = locationIdentity(cache)
            const passesLocationGuard = shouldEmitStateSync(changed, lastIdentity, nextIdentity)
            lastIdentity = nextIdentity
            if (!passesLocationGuard) return
            const snapshot = libStateToSnapshot(cache)
            const fingerprint = snapshotFingerprint(snapshot)
            if (fingerprint === lastSnapshotFingerprint) return
            lastSnapshotFingerprint = fingerprint
            offer(stateSyncFrame(changed, snapshot, account.currentTick))
          })

          // --- Sink 3: liveness. --------------------------------------------
          // The replacement for the deleted wall-clock staleness banner. These
          // only fire at all because the Account was constructed with BOTH
          // `credentials` and `reconnect: true`; registering the listeners
          // without those two is a no-op (`shouldReconnect`, account.ts).
          account.onDisconnected((err: ConnectionClosedError) => {
            offer(connectionStateFrame("disconnected", { reason: err.reason ?? err.message }))
            runFork(emitWs("error", `Live feed lost (${err.code ?? "?"}) — ${err.message}`))
          })
          account.onReconnecting((attempt: number) => {
            offer(connectionStateFrame("reconnecting", { attempt }))
          })
          account.onReconnected(() => {
            offer(connectionStateFrame("connected"))
            runFork(emitWs("system", "Live feed restored"))
            resyncScheduler.schedule()
          })

          // --- Handshake: three awaited calls, no drain loop. ---------------
          const welcome = yield* Effect.tryPromise({
            try: () => account.connect(),
            catch: (e) => new GameSocketError("Failed to open game socket", e),
          })
          yield* Effect.tryPromise({
            try: () => account.authenticate(credentials()),
            catch: (e) => new GameSocketError("Failed to authenticate", e),
          })

          const tickIntervalSec = welcome.tick_rate ?? 10
          const initialTick = welcome.current_tick ?? 0

          // `seedState: true` issues get_status as part of auth, so all 8
          // sections are populated by the time authenticate() resolves —
          // verified live 2026-08-02 (124ms after connect, all 8 at once).
          const cache = account.state
          lastIdentity = locationIdentity(cache)
          const snapshot = libStateToSnapshot(cache)
          lastSnapshotFingerprint = snapshotFingerprint(snapshot)
          const initialState = initialGameState(snapshot, initialTick)

          if (initialState.player?.username === undefined) {
            return yield* Effect.fail(
              new GameSocketError("Authenticated but the state cache never seeded a player"),
            )
          }

          yield* emitWs(
            "system",
            `Logged in as ${initialState.player.username} in ${
              initialState.system?.name ?? initialState.player.current_system
            } (tick_rate=${tickIntervalSec}s)`,
          )

          // Ask the server to push observation_update frames. Best-effort — the
          // read path is useful without it, and the library re-subscribes on
          // reconnect by itself.
          yield* Effect.tryPromise({
            try: () => account.subscribeObservation(),
            catch: (e) => e,
          }).pipe(
            Effect.catchAll(() => emitWs("error", "Failed to subscribe to observation updates")),
          )

          offer(connectionStateFrame("connected"))

          // Reconciliation floor for the agent's out-of-band REST actions.
          const idleMs = resolveResyncIdleMs()
          if (idleMs > 0) {
            idleTimer = setInterval(() => resyncScheduler.schedule(), idleMs)
            idleTimer.unref?.()
          }

          return { events, initialState, tickIntervalSec, initialTick }
        }),
    }),
  )
