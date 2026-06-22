import { Effect, Scope } from "effect"
import { Command, CommandExecutor } from "@effect/platform"
import type { TierSpec } from "./model-tier-spec.js"
import type { ModelBackend, RunningServer } from "./model-backend.js"
import { SpawnError, ReadinessError } from "./model-backend.js"

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
  deps: { fetchImpl?: typeof fetch } = {},
): Effect.Effect<ModelBackend, never, CommandExecutor.CommandExecutor> {
  return Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor
    const fetchImpl = deps.fetchImpl ?? fetch

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
        const cmd = Command.make("mlx_lm.server", ...buildMlxArgs(spec))
        const proc = yield* executor.start(cmd).pipe(
          Effect.mapError((e) => new SpawnError(spec.tier, spec.model, "executor.start failed", e)),
        )
        return { spec, spawned: true, pid: proc.pid }
      })

    const readinessProbe = (spec: TierSpec): Effect.Effect<void, ReadinessError> =>
      probeOnce(spec).pipe(
        Effect.flatMap((result) =>
          result.ready
            ? Effect.void
            : Effect.fail(
                new ReadinessError(
                  spec.tier,
                  spec.model,
                  result.reason ?? "generate probe did not confirm the expected model",
                  false,
                ),
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

    return { spawn, readinessProbe, kill, isHealthy }
  })
}
