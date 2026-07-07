import { Effect, Ref } from "effect"

/**
 * Supervision for the periodic full-state refresh, extracted from
 * `game-socket-impl.ts` so it can be unit-tested with injected deps (no live
 * socket, no `@spacemolt/client-v2` import). See that module for the wire-level
 * wiring; this module owns only the timing/latch/watchdog logic.
 *
 * Two failure modes it defends against:
 *  1. A single `performRefresh` that never settles (half-open socket / library
 *     reconnect edge) would wedge the skip-if-busy latch forever. `refreshOnce`
 *     bounds every attempt at the Effect layer so the latch is ALWAYS released.
 *  2. Even bounded, a persistently-failing channel would silently stop
 *     producing fresh state. The watchdog (`checkStale`) notices, escalates
 *     LOUDLY (throttled), defensively resets the latch, and forces a refresh.
 */
export interface StateRefreshDeps {
  /**
   * Perform ONE full-state refresh. Resolves `true` on success (a fresh frame
   * was enqueued), `false` on an error frame. MUST NOT fail the effect — it
   * self-handles and logs its own error frames.
   */
  readonly performRefresh: Effect.Effect<boolean>
  /** Emit a system/error line (the caller wires this to the ws behavior log). */
  readonly emit: (kind: "system" | "error", msg: string) => Effect.Effect<void>
  /** Current socket connection/auth status, for diagnostics in escalations. */
  readonly status: () => string
  /** Wall clock, injected so tests control staleness without a TestClock. */
  readonly now?: Effect.Effect<number>
  /** Interval between periodic refreshes AND watchdog checks. */
  readonly intervalMs: number
  /** Per-refresh ceiling; a refresh that outlives this is abandoned. */
  readonly timeoutMs: number
  /**
   * Small grace added to `timeoutMs` for the Effect-layer bound, so it trips
   * only AFTER the request's own internal timeout would have — the belt beyond
   * the suspenders. Defaults to 2s. Injectable so tests can shrink it.
   */
  readonly timeoutGraceMs?: number
  /** Max age of the last SUCCESSFUL refresh before the watchdog escalates. */
  readonly staleCeilingMs: number
}

const DEFAULT_TIMEOUT_GRACE_MS = 2_000

export interface StateRefreshLoop {
  /** Latch-guarded, timeout-bounded single refresh. Updates lastOkAt on success. */
  readonly refreshOnce: Effect.Effect<void>
  /** Watchdog decision: escalate (throttled) + reset latch + force a refresh when stale. */
  readonly checkStale: Effect.Effect<void>
  /** `forkScoped` this: forever { sleep interval; refreshOnce }. */
  readonly runPeriodic: Effect.Effect<never>
  /** `forkScoped` this: forever { sleep interval; checkStale }. */
  readonly runWatchdog: Effect.Effect<never>
}

export const makeStateRefreshLoop = (
  deps: StateRefreshDeps,
): Effect.Effect<StateRefreshLoop> =>
  Effect.gen(function* () {
    const now = deps.now ?? Effect.sync(() => Date.now())
    const graceMs = deps.timeoutGraceMs ?? DEFAULT_TIMEOUT_GRACE_MS

    // Skip-if-busy latch: a slow refresh never overlaps the next trigger.
    const refreshInFlight = yield* Ref.make(false)
    // Timestamp of the last SUCCESSFUL full-state refresh. Seed to "now" so a
    // freshly-connected socket isn't immediately judged stale.
    const startedAt = yield* now
    const lastOkAt = yield* Ref.make(startedAt)
    // Last watchdog escalation, for throttling. Seed far in the past so the
    // first genuine staleness always escalates.
    const lastEscalatedAt = yield* Ref.make(Number.NEGATIVE_INFINITY)

    // ONE refresh, bounded at the Effect layer regardless of library behavior.
    // Interrupting Effect.tryPromise does not cancel the underlying JS promise,
    // but the abandoned get_state is an idempotent query whose late result is
    // simply ignored (the fiber is gone). What matters is `ensuring` ALWAYS
    // runs, so the latch is guaranteed released.
    const refreshOnce = Effect.gen(function* () {
      const busy = yield* Ref.getAndSet(refreshInFlight, true)
      if (busy) return
      yield* deps.performRefresh
        .pipe(
          Effect.timeoutFail({
            duration: `${deps.timeoutMs + graceMs} millis`,
            onTimeout: () => "refresh-timeout" as const,
          }),
          Effect.flatMap((ok) =>
            ok
              ? Effect.flatMap(now, (t) => Ref.set(lastOkAt, t))
              : Effect.void,
          ),
          Effect.catchAll(() =>
            deps.emit(
              "error",
              `Full-state refresh timed out after ${deps.timeoutMs}ms (socket status=${deps.status()})`,
            ),
          ),
          Effect.ensuring(Ref.set(refreshInFlight, false)),
        )
    })

    // Watchdog: if the last successful refresh is older than the ceiling, the
    // refresh flow has silently died. Escalate loudly (throttled to once per
    // ceiling window), defensively un-wedge the latch, and force a refresh.
    const checkStale = Effect.gen(function* () {
      const t = yield* now
      const okAt = yield* Ref.get(lastOkAt)
      const age = t - okAt
      if (age <= deps.staleCeilingMs) return

      const lastEsc = yield* Ref.get(lastEscalatedAt)
      if (t - lastEsc < deps.staleCeilingMs) return // throttle
      yield* Ref.set(lastEscalatedAt, t)

      const ageSec = Math.round(age / 1000)
      yield* deps.emit(
        "error",
        `Full-state refresh stale for ${ageSec}s (socket status=${deps.status()}) — forcing recovery`,
      )
      // (b) defensively reset the latch in case a wedged refresh held it.
      yield* Ref.set(refreshInFlight, false)
      // (c) trigger one immediate recovery refresh without blocking the watchdog.
      yield* Effect.fork(refreshOnce)
    })

    const runPeriodic = Effect.forever(
      Effect.sleep(`${deps.intervalMs} millis`).pipe(Effect.zipRight(refreshOnce)),
    )
    const runWatchdog = Effect.forever(
      Effect.sleep(`${deps.intervalMs} millis`).pipe(Effect.zipRight(checkStale)),
    )

    return { refreshOnce, checkStale, runPeriodic, runWatchdog }
  })
