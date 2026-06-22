import { Effect, Ref, Scope, Stream } from "effect"
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
 * The injectable spawn seam. `makeMlxBackend` consumes a `SpawnedProcess` so
 * unit tests can drive a fake child process (with a fake stderr stream) without
 * a real mlx_lm.server. The default seam adapts `CommandExecutor.start`.
 */
export interface SpawnedProcess {
  readonly pid: number
  readonly stderr: StreamType.Stream<Uint8Array, unknown>
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
  } = {},
): Effect.Effect<ModelBackend, never, CommandExecutor.CommandExecutor> {
  return Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor
    const fetchImpl = deps.fetchImpl ?? fetch

    // Default spawn seam: start mlx_lm.server and adapt the platform Process to
    // our SpawnedProcess shape (pid + stderr stream). Tests inject their own.
    const startProcess =
      deps.startProcess ??
      ((spec: TierSpec): Effect.Effect<SpawnedProcess, unknown, Scope.Scope> =>
        executor
          .start(Command.make("mlx_lm.server", ...buildMlxArgs(spec)))
          .pipe(Effect.map((proc) => ({ pid: proc.pid, stderr: proc.stderr }))))

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

        return { spec, spawned: true, pid: proc.pid, stderrTail }
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

    const kill = (server: RunningServer): Effect.Effect<void> =>
      server.pid == null
        ? Effect.void
        : Effect.sync(() => {
            try { process.kill(server.pid as number, "SIGTERM") } catch { /* already gone */ }
          })

    const isHealthy = (spec: TierSpec): Effect.Effect<boolean> =>
      probeOnce(spec).pipe(Effect.map((r) => r.ready))

    return { spawn, readinessProbe, readinessProbeFor, kill, isHealthy }
  })
}
