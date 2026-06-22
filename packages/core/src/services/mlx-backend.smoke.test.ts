import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import { NodeContext } from "@effect/platform-node"
import { makeMlxBackend } from "./mlx-backend.js"
import { acquireReady } from "./ModelService.js"
import { resolveTierSpec } from "./model-tier-spec.js"

// Real spawn/probe/kill of the small 2B through MlxBackend. Gated: this spawns a
// real mlx_lm.server, so it never runs in CI / the default suite.
//   ROCI_MODEL_SMOKE_SPAWN=1 npx vitest run packages/core/src/services/mlx-backend.smoke.test.ts
//
// This drives readiness through the PRODUCTION wait path — ModelService's
// `acquireReady` — NOT a hand-rolled retry. acquireReady spawns the server (it
// isn't healthy yet), POLLS readinessProbe on a 1s interval bounded by the
// tier's timeoutMs, and registers a spawned-only kill finalizer on the scope.
// So this smoke CANNOT pass while the production readiness gate is broken
// (single-shot), and tears down the spawned server when the scope closes.
describe.skipIf(!process.env.ROCI_MODEL_SMOKE_SPAWN)(
  "MlxBackend real spawn/probe/kill (hindbrain 2B) via production acquireReady",
  () => {
    it("spawns the 2B and polls it ready through acquireReady, then kills it on scope close", async () => {
      const spec = resolveTierSpec("hindbrain") // Qwen3.5-2B on 8081
      const program = Effect.gen(function* () {
        const backend = yield* makeMlxBackend()
        // Production wait path: spawn (not healthy yet) → poll readiness under
        // the tier timeout. Returns once a real 1-token generate returns 2xx.
        const server = yield* acquireReady(backend, spec)
        // Confirm it's genuinely serving after the gate passed.
        const healthy = yield* backend.isHealthy(spec)
        return { healthy, spawned: server.spawned }
      }).pipe(Effect.scoped, Effect.provide(NodeContext.layer))

      const { healthy, spawned } = await Effect.runPromise(program)
      expect(spawned).toBe(true) // we spawned it (wasn't already running)
      expect(healthy).toBe(true) // and it answers a generate after the gate
    }, 180_000)
  },
)
