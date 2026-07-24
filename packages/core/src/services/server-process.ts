import { Deferred, Effect, Ref, Scope, Stream } from "effect"
import type { Stream as StreamType } from "effect"
import type { TierSpec } from "./model-tier-spec.js"
import type { ModelBackend, RunningServer } from "./model-backend.js"
import { SpawnError, ReadinessError } from "./model-backend.js"

// ---------------------------------------------------------------------------
// Shared, backend-AGNOSTIC server-process scaffolding.
//
// Both the mlx (`mlx-backend.ts`) and llama.cpp (`llamacpp-backend.ts`) backends
// spawn a local OpenAI-compatible HTTP server, poll it ready with the SAME strict
// readiness contract (a real 1-token generate whose response `model` must ===
// spec.model), keep the SAME bounded stderr ring for post-mortems, track RESIDENT
// pids in the SAME synchronous orphan-reaper registry, and tear down with the SAME
// group-kill (SIGTERM → grace → SIGKILL) finalizer. Extracting all of that here
// means the readiness contract cannot drift between backends — the one place a
// mismatch would silently never-ready a resident tier and hard-fail the layer at
// boot. What stays backend-specific and is injected as `startProcess`: (a) command
// resolution and (b) arg building.

/**
 * Bound on the in-memory stderr tail kept per spawned server. These servers are
 * chatty on stderr (progress bars, token timings); we only need the most recent
 * lines for a post-mortem, so the ring drops the oldest beyond this cap.
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
 * the process lifetime.
 */
export const STDERR_TAIL_MAX_LINES = 200
export const STDERR_TAIL_MAX_LINE_LEN = 2_000

// ---------------------------------------------------------------------------
// Synchronous orphan-reaper backstop for RESIDENT model servers.
//
// PROBLEM this guards: the live/QA session can be launched under bare `tsx`,
// which double-forks (a tsx-CLI parent spawns a worker that runs main.ts). On
// SIGTERM the tsx parent forwards SIGTERM to the worker, waits only ~30ms for an
// IPC echo, then SIGKILLs the worker. Effect's async kill finalizer (the awaited
// SIGTERM→grace→SIGKILL escalation in `kill` below) cannot complete in that
// window, so the RESIDENT conscious server (port 8083) orphans — surviving the
// worker death while holding its port and a large RAM slice.
//
// THIS backstop is SYNCHRONOUS: a `process.on("SIGTERM"|"SIGINT")` handler (wired
// in apps/roci/src/main.ts) calls `reapResidentServers`, which runs to completion
// inside the 30ms window because it does no awaiting — just a synchronous group
// `process.kill(-pgid, "SIGKILL")` per tracked resident pid. It is a backstop,
// NOT a replacement for the `kill` finalizer (which is correct on the
// non-double-forking packaged path and on per-phase teardown). Per-phase servers
// are reaped during normal tick operation, so only resident pids are tracked.
//
// The server is spawned detached, so it is its own process-group leader (PGID ===
// pid, verified live). A single group SIGKILL reaps it and its worker
// subprocesses instantly.
interface ResidentServerEntry {
  readonly pid: number
  readonly pgid: number
}

// Module-level registry of live RESIDENT model server pids. Populated when a
// resident server is spawned (in `spawn`, gated on spec.lifecycle), removed on
// normal kill. Keyed by pid so re-registration can't duplicate an entry. Shared
// across backends: whichever backend spawns the resident tier registers here.
const residentServers = new Map<number, ResidentServerEntry>()

/**
 * Record a spawned RESIDENT model server so the synchronous reaper can group-kill
 * it if the process is SIGKILLed before the async `kill` finalizer can run.
 * `pgid` is the process-group id to signal (PGID === pid for our detached spawns).
 */
export function registerResidentServer(pid: number, pgid: number): void {
  residentServers.set(pid, { pid, pgid })
}

/** Remove a resident server from the registry (on normal, finalizer-driven kill). */
export function unregisterResidentServer(pid: number): void {
  residentServers.delete(pid)
}

/** Test-only view of the currently tracked resident pids (insertion order). */
export function _residentServerPids(): ReadonlyArray<number> {
  return [...residentServers.keys()]
}

/**
 * The synchronous signal function the reaper drives. Defaults to `process.kill`.
 * `target` is a NEGATIVE pgid (group target). Throws on ESRCH/EPERM, which the
 * reaper swallows. Injected by tests to assert the group target without
 * signalling a real process.
 */
export type SyncKill = (target: number, signal: NodeJS.Signals) => void

const defaultSyncKill: SyncKill = (target, signal) => {
  process.kill(target, signal)
}

/**
 * SYNCHRONOUSLY reap every tracked resident model server by group-SIGKILL. Runs
 * inside the tsx ~30ms SIGTERM→SIGKILL window (no awaiting). Swallows ESRCH (the
 * group is already gone) and any other per-target error so one dead target can't
 * abort reaping the rest. Clears the registry so a second call is an idempotent
 * no-op (e.g. SIGTERM handler then 'exit' backstop both fire).
 */
export function reapResidentServers(kill: SyncKill = defaultSyncKill): void {
  for (const { pgid } of residentServers.values()) {
    try {
      kill(-pgid, "SIGKILL")
    } catch {
      // ESRCH (already gone) / EPERM — best-effort backstop, keep reaping.
    }
  }
  residentServers.clear()
}
// ---------------------------------------------------------------------------

/**
 * Grace period between the SIGTERM and the escalation SIGKILL when tearing down a
 * spawned model server. A heavy resident tier can sit unresponsive mid-load and
 * not reap promptly on SIGTERM alone; if it is still alive when this window
 * elapses we escalate to SIGKILL on the process group so it can't survive scope
 * close as orphans eating swap.
 *
 * This grace is AWAITED inside the kill finalizer (see `kill`), so it adds
 * directly to shutdown latency — but only for a genuinely-stuck server: the
 * finalizer races "process exited" against this grace and returns immediately on
 * the common clean-exit path. A server that hasn't acknowledged SIGTERM in 2.5s
 * is almost certainly wedged (not just slow), and 2.5s is an acceptable
 * worst-case block on whole-app shutdown.
 */
export const KILL_GRACE_MS = 2_500

/**
 * The injectable signal seam. `kill` terminates the spawned server's whole
 * PROCESS GROUP (not just the leader pid) and escalates SIGTERM → SIGKILL. The
 * platform spawns children `detached`, so the leader pid is its own group leader
 * (PGID === pid) and `process.kill(-pid, sig)` reaches the server's worker
 * subprocesses too. Tests inject a spy to assert the group-target + escalation
 * without real processes. Returns true if the signal was delivered, false if the
 * target was already gone (ESRCH) — caller treats "already gone" as success.
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
 * The injectable spawn seam. `makeServerBackend` consumes a `SpawnedProcess` so
 * unit tests can drive a fake child process (with a fake stderr stream) without a
 * real server. Each backend's default seam adapts `CommandExecutor.start` for its
 * own resolved command + args.
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

/**
 * Dependencies for the shared backend factory. `startProcess` is the ONLY
 * backend-specific piece — each backend injects its own default that resolves its
 * command + builds its args, then spawns via CommandExecutor. `stderrLabel` names
 * the server in the ReadinessError post-mortem ("mlx" / "llama.cpp").
 */
export interface ServerBackendDeps {
  readonly startProcess: (spec: TierSpec) => Effect.Effect<SpawnedProcess, unknown, Scope.Scope>
  readonly fetchImpl?: typeof fetch
  readonly killSeam?: KillSeam
  readonly stderrLabel?: string
}

/**
 * Build a `ModelBackend` from a backend-specific `startProcess` seam plus the
 * shared readiness/registry/stderr/kill scaffolding. Pure construction (no
 * context), so each backend factory acquires its own CommandExecutor to build the
 * default `startProcess`, then delegates the rest here — guaranteeing the
 * readiness contract and teardown behavior are IDENTICAL across backends.
 */
export function makeServerBackend(deps: ServerBackendDeps): ModelBackend {
  const fetchImpl = deps.fetchImpl ?? fetch
  const killSeam = deps.killSeam ?? defaultKillSeam
  const stderrLabel = deps.stderrLabel ?? "server"
  const startProcess = deps.startProcess

  // A 2xx alone does NOT prove the right model loaded: a stale server bound to
  // the port, or a wrong model, still answers 200. Readiness is only true when
  // the server echoes the expected model id in the completion response (the
  // OpenAI-compatible API returns the served model id as the top-level `model`
  // field). We surface enough detail to name expected vs actual in a
  // ReadinessError. A missing/empty model field is "not ready", not a crash —
  // the server may not be fully up yet.
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
        // Preserve an already-actionable SpawnError from the seam (e.g. the
        // missing-runtime preflight) rather than re-wrapping it as a generic
        // "executor.start failed"; wrap anything else.
        Effect.mapError((e) =>
          e instanceof SpawnError ? e : new SpawnError(spec.tier, spec.model, "executor.start failed", e),
        ),
      )

      // Bounded in-memory ring of the most recent stderr lines. The server's
      // stderr was previously discarded, so a mid-session death left ZERO captured
      // output and the cause could not be confirmed. We keep a tail so a
      // readiness/spawn failure surface can name what the server printed before it
      // died, without standing up a logging subsystem.
      const ring = yield* Ref.make<ReadonlyArray<string>>([])
      const pushLine = (line: string) =>
        Ref.update(ring, (lines) => {
          const next = [...lines, line.slice(0, STDERR_TAIL_MAX_LINE_LEN)]
          return next.length > STDERR_TAIL_MAX_LINES
            ? next.slice(next.length - STDERR_TAIL_MAX_LINES)
            : next
        })

      // Drain stderr into the ring on a background fiber, scoped to the server's
      // lifetime. Failures draining stderr must never crash the spawn —
      // diagnostics are best-effort.
      yield* proc.stderr.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach(pushLine),
        Effect.catchAllCause(() => Effect.void),
        Effect.forkScoped,
      )

      const stderrTail = (): Effect.Effect<string> =>
        Ref.get(ring).pipe(Effect.map((lines) => lines.join("\n")))

      // Track RESIDENT servers in the module-level registry so the synchronous
      // orphan reaper can group-kill them if the worker is SIGKILLed before the
      // async `kill` finalizer runs (the tsx double-fork shutdown race). The spawn
      // is detached, so the leader pid is its own group leader (PGID === pid).
      // Per-phase servers are reaped in normal operation and not tracked.
      if (spec.lifecycle === "resident") {
        registerResidentServer(proc.pid, proc.pid)
      }

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
      Effect.map(
        (tail) =>
          new ReadinessError(
            spec.tier,
            spec.model,
            tail.length > 0 ? `${reason}\n--- recent ${stderrLabel} stderr ---\n${tail}` : reason,
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
  // carries the spawned server's stderr tail. ModelService uses this on the wait
  // path so a never-ready / dead server names its own last words.
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

  // Signal the spawned server's whole PROCESS GROUP, falling back to the bare pid
  // if the group signal can't be delivered (negative-pid not supported, or ESRCH).
  // Returns true once a signal landed OR the target is already gone.
  const signalGroupOrPid = (pid: number, signal: "SIGTERM" | "SIGKILL"): boolean => {
    // `-pid` targets the process group (PGID === leader pid, since the platform
    // spawns detached). This reaps worker subprocesses, not just the leader.
    if (killSeam.send(-pid, signal)) return true
    // Group target unreachable (e.g. already gone, or no group): try the pid.
    return killSeam.send(pid, signal)
  }

  // Tear down a spawned server: SIGTERM the whole group, then — if the process is
  // still alive after a bounded grace — SIGKILL the whole group, so a heavy model
  // that won't reap on SIGTERM is forcibly reaped instead of surviving scope close
  // as orphans.
  //
  // The escalation is AWAITED inside this finalizer, NOT detached onto a daemon.
  // NodeRuntime.runMain interrupts the root fiber, runs finalizers to completion,
  // then calls process.exit; it AWAITS finalizer effects but does NOT await daemon
  // fibers — a forkDaemon'd SIGKILL would be killed by process.exit before its
  // grace elapsed. Awaiting the escalation here means runMain blocks on it before
  // exiting, so the SIGKILL actually lands.
  //
  // Fast path preserved: this finalizer runs on EVERY per-phase teardown, so it
  // must not unconditionally block for the full grace. We resolve "did the process
  // exit within the grace?" and return the instant we know.
  //
  // SIGKILL is GATED on observing the process still alive after the grace. For an
  // adopted server (no awaitExit) we can't observe exit, so we fall back to the
  // time-bounded behavior. SIGKILL on an already-dead group is a harmless no-op.
  //
  // HOW we observe exit without deadlocking: a scope finalizer runs in an
  // UNINTERRUPTIBLE region, so `Effect.race` would hang trying to interrupt the
  // loser. Instead two daemon writers race to fill ONE Deferred — `awaitExit`
  // writes `true`, the grace timer writes `false` — and the finalizer only AWAITS
  // the Deferred. First writer wins; no interruption of a never-completing effect.
  const observeExitedWithinGrace = (awaitExit: Effect.Effect<void>): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const outcome = yield* Deferred.make<boolean>()
      // Exit observer: when the process exits, record "exited within grace".
      yield* awaitExit.pipe(Effect.zipRight(Deferred.succeed(outcome, true)), Effect.forkDaemon)
      // Grace timer: when the grace elapses, record "still alive". `succeed` on an
      // already-filled Deferred is a no-op, so whichever fires first wins.
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
          // This finalizer is now driving teardown, so drop the server from the
          // synchronous-reaper registry: the reaper is a backstop for the case
          // where this finalizer can't run, not a parallel killer. Harmless for
          // per-phase pids (never registered → no-op delete).
          yield* Effect.sync(() => unregisterResidentServer(pid))
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
}
