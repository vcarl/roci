import { Effect } from "effect"

/**
 * Domain-layer hard-reconnect for the game socket, extracted so the
 * backoff schedule and teardown-then-redial ordering are unit-testable with
 * injected deps (no live socket, no `@spacemolt/client-v2` import).
 *
 * Why this exists: `@spacemolt/client-v2` owns a transparent internal reconnect
 * (exp. backoff, `maxAttempts: Infinity` by default) that self-heals TRANSIENT
 * drops. But it gives up PERMANENTLY — status latches to `"closed"`, its event
 * queue ends — on an auth failure during a reconnect (see the library's
 * `handleAuthFailure`). Once terminal, the old code's watchdog only re-issued a
 * `get_state` on the dead socket, which throws "Cannot send on a closed socket".
 * There was no path back to a live feed. This module supplies that path: throw
 * the corpse away and dial a brand-new socket (fresh handshake + login), forever.
 */

export interface BackoffPolicy {
  /** Delay before the FIRST retry. */
  readonly initialMs: number
  /** Ceiling the delay is clamped to. */
  readonly maxMs: number
  /** Geometric growth factor between attempts. */
  readonly factor: number
}

/** 1s → 2s → 4s → 8s → 16s → 30s (capped), retrying indefinitely. */
export const DEFAULT_BACKOFF: BackoffPolicy = {
  initialMs: 1_000,
  maxMs: 30_000,
  factor: 2,
}

/**
 * Delay before the Nth (1-indexed) redial attempt: `initialMs * factor^(n-1)`,
 * clamped to `[0, maxMs]`. Attempt 1 → initialMs; the cap makes the schedule
 * bounded even as attempts climb without bound.
 */
export const backoffDelayMs = (
  attempt: number,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
): number => {
  const n = Math.max(1, Math.floor(attempt))
  const raw = policy.initialMs * Math.pow(policy.factor, n - 1)
  return Math.min(policy.maxMs, Math.max(0, raw))
}

export interface ReconnectDeps<S> {
  /**
   * Tear down the dead connection FIRST: close the socket, release its
   * listeners. Best-effort — any failure is swallowed (the caller can't recover
   * a teardown error, and a stuck close must not block the redial).
   */
  readonly teardown: (previous: S) => Effect.Effect<void, unknown>
  /** Dial a fresh connection (createSocket + handshake + resubscribe). May fail. */
  readonly dial: Effect.Effect<S, unknown>
  /** Emit a system/error line (wired to the ws behavior log). */
  readonly emit: (kind: "system" | "error", msg: string) => Effect.Effect<void>
  /** Injectable sleep so tests drive backoff without real time. */
  readonly sleep?: (ms: number) => Effect.Effect<void>
  readonly policy?: BackoffPolicy
}

/**
 * Recover a dead connection: tear the corpse down FIRST, then re-dial with
 * capped exponential backoff, retrying INDEFINITELY (an unattended agent must
 * self-heal). Resolves with the fresh connection on the first successful dial.
 * Backoff "resets" naturally — each invocation starts its own attempt counter,
 * so a clean reconnect that later dies begins again at `initialMs`.
 */
export const reconnectWithBackoff = <S>(
  previous: S | null,
  deps: ReconnectDeps<S>,
): Effect.Effect<S> =>
  Effect.gen(function* () {
    const sleep = deps.sleep ?? ((ms: number) => Effect.sleep(`${ms} millis`))
    const policy = deps.policy ?? DEFAULT_BACKOFF

    // Teardown strictly precedes the first dial so a half-open socket can't keep
    // pushing stale frames alongside the fresh one.
    if (previous !== null) {
      yield* deps.teardown(previous).pipe(Effect.catchAll(() => Effect.void))
    }

    let attempt = 0
    for (;;) {
      attempt += 1
      const result = yield* Effect.either(deps.dial)
      if (result._tag === "Right") {
        if (attempt > 1) {
          yield* deps.emit("system", `Reconnected after ${attempt} attempts — live feed restored.`)
        }
        return result.right
      }
      const delay = backoffDelayMs(attempt, policy)
      yield* deps.emit(
        "error",
        `Reconnect attempt ${attempt} failed (${String(result.left)}); retrying in ${Math.round(delay / 1000)}s`,
      )
      yield* sleep(delay)
    }
  })
