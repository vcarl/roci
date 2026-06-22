import { Effect, Scope } from "effect"
import { Command, CommandExecutor } from "@effect/platform"
import type { TierSpec } from "./model-tier-spec.js"
import type { ModelBackend, RunningServer } from "./model-backend.js"
import { SpawnError, ReadinessError } from "./model-backend.js"

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

    const probeOnce = (spec: TierSpec): Effect.Effect<boolean> =>
      Effect.tryPromise({
        try: async () => {
          const { url, body } = buildProbeRequest(spec)
          const res = await fetchImpl(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
          return res.ok
        },
        catch: () => false,
      }).pipe(Effect.catchAll(() => Effect.succeed(false)), Effect.map((ok) => ok === true))

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
        Effect.flatMap((ok) =>
          ok
            ? Effect.void
            : Effect.fail(
                new ReadinessError(spec.tier, spec.model, "generate probe did not return 2xx", false),
              ),
        ),
      )

    const kill = (server: RunningServer): Effect.Effect<void> =>
      server.pid == null
        ? Effect.void
        : Effect.sync(() => {
            try { process.kill(server.pid as number, "SIGTERM") } catch { /* already gone */ }
          })

    const isHealthy = (spec: TierSpec): Effect.Effect<boolean> => probeOnce(spec)

    return { spawn, readinessProbe, kill, isHealthy }
  })
}
