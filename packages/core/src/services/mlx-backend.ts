import { Deferred, Effect, Ref, Scope, Stream } from "effect"
import { Command, CommandExecutor } from "@effect/platform"
import type { Stream as StreamType } from "effect"
import type { TierSpec } from "./model-tier-spec.js"
import type { ModelBackend, RunningServer } from "./model-backend.js"
import { SpawnError, ReadinessError } from "./model-backend.js"

/**
 * Bound on the in-memory stderr tail kept per spawned mlx server. mlx_lm.server
 * is chatty on stderr (progress bars, token timings); we only need the most
 * recent lines for a post-mortem, so the ring drops the oldest beyond this cap.
 *
 * What these caps actually bound: STDERR_TAIL_MAX_LINE_LEN bounds the stored
 * length of each EMITTED line (applied in pushLine, slicing the line we retain),
 * and STDERR_TAIL_MAX_LINES bounds how many such lines the ring retains. Both
 * only take effect once Stream.splitLines has emitted a completed line.
 *
 * Known limitation: the per-line cap does NOT bound the in-flight splitLines
 * accumulator for a line that has not yet been terminated by a newline.
 * splitLines accumulates bytes across chunks until it sees a `\n`, so a flood
 * with no `\n` — e.g. `\r`-delimited tqdm progress bars during a large model
 * load — grows upstream of pushLine, unbounded by this code and bounded only by
 * the process lifetime. Confirm against real mlx output before relying on these
 * caps for the no-newline case; this is comment-only and does not rebuild the
 * splitting logic.
 */
export const STDERR_TAIL_MAX_LINES = 200
export const STDERR_TAIL_MAX_LINE_LEN = 2_000

/**
 * Grace period between the SIGTERM and the escalation SIGKILL when tearing down a
 * spawned mlx server. mlx_lm.server (especially the heavy 122B conscious tier)
 * can sit unresponsive mid-load and not reap promptly on SIGTERM alone; if it is
 * still alive when this window elapses we escalate to SIGKILL on the process
 * group so it can't survive scope close as orphans eating swap.
 *
 * This grace is now AWAITED inside the kill finalizer (see `kill`), so it adds
 * directly to shutdown latency — but only for a genuinely-stuck server: the
 * finalizer races "process exited" against this grace and returns immediately on
 * the common clean-exit path. We shortened it from 5s to 2.5s because a server
 * that hasn't acknowledged SIGTERM in 2.5s is almost certainly wedged (not just
 * slow), and 2.5s is an acceptable worst-case block on whole-app shutdown.
 */
export const KILL_GRACE_MS = 2_500

/**
 * The injectable signal seam. `kill` terminates the spawned mlx server's whole
 * PROCESS GROUP (not just the leader pid) and escalates SIGTERM → SIGKILL. The
 * platform spawns children `detached`, so the leader pid is its own group leader
 * (PGID === pid) and `process.kill(-pid, sig)` reaches mlx's worker subprocesses
 * too. Tests inject a spy to assert the group-target + escalation without real
 * processes. Returns true if the signal was delivered, false if the target was
 * already gone (ESRCH) — caller treats "already gone" as success.
 */
export interface KillSeam {
  readonly send: (target: number, signal: "SIGTERM" | "SIGKILL") => boolean
}

const defaultKillSeam: KillSeam = {
  send: (target, signal) => {
    try {
      process.kill(target, signal)
      return true
    } catch {
      // ESRCH (no such process/group) or EPERM — treat as "already gone".
      return false
    }
  },
}

/**
 * The injectable spawn seam. `makeMlxBackend` consumes a `SpawnedProcess` so
 * unit tests can drive a fake child process (with a fake stderr stream) without
 * a real mlx_lm.server. The default seam adapts `CommandExecutor.start`.
 */
export interface SpawnedProcess {
  readonly pid: number
  readonly stderr: StreamType.Stream<Uint8Array, unknown>
  /**
   * Completes when the spawned process actually exits. The default seam adapts
   * the platform Process's `.exitCode` effect (which suspends until exit). The
   * kill finalizer races this against the SIGTERM grace so it can return the
   * instant the server reaps — and only fire SIGKILL if the process is still
   * alive when the grace elapses. Must never fail: any error observing exit is
   * treated as "the process is gone". Tests drive it with a TestClock-gated
   * effect so the fast path and the stuck path are both deterministic.
   */
  readonly awaitExit: Effect.Effect<void>
}

/**
 * Outcome of a single readiness probe. `ready` is only true once the server has
 * confirmed the expected model id; otherwise `reason` explains why (and `actual`
 * carries the wrong model id, when the server reported one).
 */
export interface ProbeResult {
  readonly ready: boolean
  readonly reason?: string
  readonly actual?: string
}

/** mlx_lm.server --model <id> --port <p> [spawnArgs…] */
export function buildMlxArgs(spec: TierSpec): ReadonlyArray<string> {
  return ["--model", spec.model, "--port", String(spec.port), ...spec.spawnArgs]
}

/** A real 1-token generate. NOT /v1/models — that 200s before weights load. */
export function buildProbeRequest(spec: TierSpec): {
  readonly url: string
  readonly body: Record<string, unknown>
} {
  return {
    url: `${spec.baseUrl.replace(/\/+$/, "")}/chat/completions`,
    body: {
      model: spec.model,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      stream: false,
    },
  }
}

export function makeMlxBackend(
  deps: {
    fetchImpl?: typeof fetch
    /**
     * Override the spawn seam. Receives the resolved spec; returns a
     * SpawnedProcess. Defaults to spawning `mlx_lm.server` via CommandExecutor.
     * The returned process's stderr is drained into a bounded tail.
     */
    startProcess?: (spec: TierSpec) => Effect.Effect<SpawnedProcess, unknown, Scope.Scope>
    /**
     * Override the signal seam used by `kill`. Defaults to `process.kill`.
     * Injected by tests to assert the process-group target and SIGTERM→SIGKILL
     * escalation without signalling real processes.
     */
    killSeam?: KillSeam
  } = {},
): Effect.Effect<ModelBackend, never, CommandExecutor.CommandExecutor> {
  return Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor
    const fetchImpl = deps.fetchImpl ?? fetch
    const killSeam = deps.killSeam ?? defaultKillSeam

    // Default spawn seam: start mlx_lm.server and adapt the platform Process to
    // our SpawnedProcess shape (pid + stderr stream). Tests inject their own.
    const startProcess =
      deps.startProcess ??
      ((spec: TierSpec): Effect.Effect<SpawnedProcess, unknown, Scope.Scope> =>
        executor
          .start(Command.make("mlx_lm.server", ...buildMlxArgs(spec)))
          .pipe(
            Effect.map((proc) => ({
              pid: proc.pid,
              stderr: proc.stderr,
              // `proc.exitCode` suspends until the process exits; we discard the
              // code and normalize any PlatformError to "exited" — for kill's
              // liveness race, an error awaiting exit still means "stop waiting".
              awaitExit: proc.exitCode.pipe(Effect.ignore),
            })),
          ))

    // A 2xx alone does NOT prove the right model loaded: a stale server bound to
    // the port, or a wrong --model, still answers 200. Readiness is only true
    // when the server echoes the expected model id in the completion response
    // (mlx_lm.server, like the OpenAI API, returns the served model id as the
    // top-level `model` field). We surface enough detail to name expected vs
    // actual in a ReadinessError. A missing/empty model field is "not ready",
    // not a crash — the server may not be fully up yet.
    const probeOnce = (spec: TierSpec): Effect.Effect<ProbeResult> =>
      Effect.tryPromise({
        try: async (): Promise<ProbeResult> => {
          const { url, body } = buildProbeRequest(spec)
          const res = await fetchImpl(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
          if (!res.ok) return { ready: false, reason: `generate probe returned HTTP ${res.status}` }
          let payload: unknown
          try {
            payload = await res.json()
          } catch {
            return { ready: false, reason: "generate probe response was not valid JSON" }
          }
          const actual =
            payload && typeof payload === "object" && "model" in payload
              ? (payload as { model?: unknown }).model
              : undefined
          if (typeof actual !== "string" || actual.length === 0) {
            return { ready: false, reason: "generate probe response had no model field" }
          }
          if (actual !== spec.model) {
            return {
              ready: false,
              reason: `wrong model loaded: expected ${spec.model}, server reported ${actual}`,
              actual,
            }
          }
          return { ready: true }
        },
        catch: (e) => ({ ready: false, reason: `generate probe failed: ${String(e)}` }) as ProbeResult,
      }).pipe(Effect.catchAll((r) => Effect.succeed(r)))

    const spawn = (spec: TierSpec): Effect.Effect<RunningServer, SpawnError, Scope.Scope> =>
      Effect.gen(function* () {
        const proc = yield* startProcess(spec).pipe(
          Effect.mapError((e) => new SpawnError(spec.tier, spec.model, "executor.start failed", e)),
        )

        // Bounded in-memory ring of the most recent stderr lines. mlx_lm.server's
        // stderr was previously discarded, so a mid-session death left ZERO
        // captured output and the cause could not be confirmed. We keep a tail so
        // a readiness/spawn failure surface can name what the server printed
        // before it died, without standing up a logging subsystem.
        const ring = yield* Ref.make<ReadonlyArray<string>>([])
        const pushLine = (line: string) =>
          Ref.update(ring, (lines) => {
            const next = [...lines, line.slice(0, STDERR_TAIL_MAX_LINE_LEN)]
            return next.length > STDERR_TAIL_MAX_LINES
              ? next.slice(next.length - STDERR_TAIL_MAX_LINES)
              : next
          })

        // Drain stderr into the ring on a background fiber, scoped to the server's
        // lifetime (the same scope acquireReady ties spawn to). Failures draining
        // stderr must never crash the spawn — diagnostics are best-effort.
        yield* proc.stderr.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach(pushLine),
          Effect.catchAllCause(() => Effect.void),
          Effect.forkScoped,
        )

        const stderrTail = (): Effect.Effect<string> =>
          Ref.get(ring).pipe(Effect.map((lines) => lines.join("\n")))

        return { spec, spawned: true, pid: proc.pid, stderrTail, awaitExit: proc.awaitExit }
      })

    // Build a ReadinessError, appending the spawned server's recent stderr tail
    // (when one is available) so a death/never-ready is diagnosable.
    const readinessFailure = (
      spec: TierSpec,
      reason: string,
      server?: RunningServer,
    ): Effect.Effect<ReadinessError> =>
      (server?.stderrTail ? server.stderrTail() : Effect.succeed("")).pipe(
        Effect.map((tail) =>
          new ReadinessError(
            spec.tier,
            spec.model,
            tail.length > 0 ? `${reason}\n--- recent mlx stderr ---\n${tail}` : reason,
            false,
          ),
        ),
      )

    const readinessProbe = (spec: TierSpec): Effect.Effect<void, ReadinessError> =>
      probeOnce(spec).pipe(
        Effect.flatMap((result) =>
          result.ready
            ? Effect.void
            : Effect.flatMap(
                readinessFailure(
                  spec,
                  result.reason ?? "generate probe did not confirm the expected model",
                ),
                Effect.fail,
              ),
        ),
      )

    // Server-bound readiness probe: identical to readinessProbe but the failure
    // carries the spawned server's stderr tail. ModelService uses this on the
    // wait path so a never-ready / dead server names its own last words.
    const readinessProbeFor = (server: RunningServer): Effect.Effect<void, ReadinessError> =>
      probeOnce(server.spec).pipe(
        Effect.flatMap((result) =>
          result.ready
            ? Effect.void
            : Effect.flatMap(
                readinessFailure(
                  server.spec,
                  result.reason ?? "generate probe did not confirm the expected model",
                  server,
                ),
                Effect.fail,
              ),
        ),
      )

    // Signal the spawned server's whole PROCESS GROUP, falling back to the bare
    // pid if the group signal can't be delivered (negative-pid not supported, or
    // ESRCH). Returns true once a signal landed OR the target is already gone —
    // either way there's nothing more to terminate for this attempt.
    const signalGroupOrPid = (pid: number, signal: "SIGTERM" | "SIGKILL"): boolean => {
      // `-pid` targets the process group (PGID === leader pid, since the platform
      // spawns detached). This reaps mlx's worker subprocesses, not just the
      // leader — the bug that orphaned children on a single-pid kill.
      if (killSeam.send(-pid, signal)) return true
      // Group target unreachable (e.g. already gone, or no group): try the pid.
      return killSeam.send(pid, signal)
    }

    // Tear down a spawned mlx server. Previously this sent a single SIGTERM to the
    // LEADER pid only, which (a) left mlx's worker subprocesses orphaned and (b)
    // could no-op the platform's own group-kill finalizer (it skips the group
    // kill when the leader already exited 0/by-signal). Now: SIGTERM the whole
    // group, then — if the process is still alive after a bounded grace — SIGKILL
    // the whole group, so a heavy model that won't reap on SIGTERM is forcibly
    // reaped instead of surviving scope close as orphans.
    //
    // The escalation is AWAITED inside this finalizer, NOT detached onto a daemon.
    // That is load-bearing for whole-app shutdown: NodeRuntime.runMain interrupts
    // the root fiber, runs finalizers to completion, then calls process.exit. It
    // AWAITS finalizer effects but does NOT await daemon fibers — a forkDaemon'd
    // SIGKILL would be killed by process.exit before its grace elapsed, so on the
    // exact "SIGTERM ignored, app shutting down" scenario this targets, the orphan
    // would leak. Awaiting the escalation here means runMain blocks on it before
    // exiting, so the SIGKILL actually lands.
    //
    // We keep the fast path: this finalizer runs on EVERY per-phase teardown, so
    // it must not unconditionally block for the full grace. We resolve "did the
    // process exit within the grace?" and return the instant we know. When the
    // server reaps promptly on SIGTERM (the common case) the finalizer returns
    // immediately; only a genuinely-stuck server pays KILL_GRACE_MS.
    //
    // SIGKILL is GATED on observing the process still alive after the grace: if
    // `awaitExit` resolved first the process is already gone and we send nothing.
    // This avoids blind-firing SIGKILL at a remembered pid/group the OS may have
    // already recycled (the pid-reuse race). For an adopted server (no awaitExit)
    // we can't observe exit, so we fall back to the time-bounded behavior:
    // SIGTERM, await the grace, then SIGKILL the group. SIGKILL on an already-dead
    // group is a harmless no-op (ESRCH → "already gone").
    //
    // HOW we observe exit without deadlocking: a scope finalizer runs in an
    // UNINTERRUPTIBLE region, so the usual `Effect.race(awaitExit, sleep)` would
    // hang trying to interrupt the loser (an `awaitExit` that never completes is
    // un-interruptible from here). Instead two daemon writers race to fill ONE
    // Deferred — `awaitExit` writes `true`, the grace timer writes `false` — and
    // the finalizer only AWAITS the Deferred. First writer wins; no interruption
    // of an un-interruptible/never effect. The awaited Deferred is what makes
    // runMain block on the escalation (it awaits finalizers, not daemons), while
    // the daemons are mere exit/timeout observers, never the escalation itself.
    const observeExitedWithinGrace = (
      awaitExit: Effect.Effect<void>,
    ): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const outcome = yield* Deferred.make<boolean>()
        // Exit observer: when the process exits, record "exited within grace".
        yield* awaitExit.pipe(
          Effect.zipRight(Deferred.succeed(outcome, true)),
          Effect.forkDaemon,
        )
        // Grace timer: when the grace elapses, record "still alive". `succeed` on
        // an already-filled Deferred is a no-op, so whichever fires first wins.
        yield* Effect.sleep(`${KILL_GRACE_MS} millis`).pipe(
          Effect.zipRight(Deferred.succeed(outcome, false)),
          Effect.forkDaemon,
        )
        return yield* Deferred.await(outcome)
      })

    const kill = (server: RunningServer): Effect.Effect<void> =>
      server.pid == null
        ? Effect.void
        : Effect.gen(function* () {
            const pid = server.pid as number
            yield* Effect.sync(() => signalGroupOrPid(pid, "SIGTERM"))
            // `true` => exited within grace, `false` => grace elapsed first (still
            // alive). Without an exit signal (adopted server) we can only wait out
            // the grace, then treat the target as still-alive and escalate.
            const exited = server.awaitExit
              ? yield* observeExitedWithinGrace(server.awaitExit)
              : yield* Effect.sleep(`${KILL_GRACE_MS} millis`).pipe(Effect.as(false))
            if (!exited) {
              yield* Effect.sync(() => signalGroupOrPid(pid, "SIGKILL"))
            }
          })

    const isHealthy = (spec: TierSpec): Effect.Effect<boolean> =>
      probeOnce(spec).pipe(Effect.map((r) => r.ready))

    return { spawn, readinessProbe, readinessProbeFor, kill, isHealthy }
  })
}
