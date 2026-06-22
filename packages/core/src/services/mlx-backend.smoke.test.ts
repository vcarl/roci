import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import { NodeContext } from "@effect/platform-node"
import { makeMlxBackend } from "./mlx-backend.js"
import { resolveTierSpec } from "./model-tier-spec.js"

// Real spawn/probe/kill of the small 2B through MlxBackend. Gated: this spawns a
// real mlx_lm.server, so it never runs in CI / the default suite.
//   ROCI_MODEL_SMOKE_SPAWN=1 npx vitest run packages/core/src/services/mlx-backend.smoke.test.ts
describe.skipIf(!process.env.ROCI_MODEL_SMOKE_SPAWN)(
  "MlxBackend real spawn/probe/kill (hindbrain 2B)",
  () => {
    it("spawns the 2B, probes it ready, then kills it", async () => {
      const spec = resolveTierSpec("hindbrain") // Qwen3.5-2B on 8081
      const program = Effect.gen(function* () {
        const backend = yield* makeMlxBackend()
        const server = yield* backend.spawn(spec)
        // poll readiness until the tier timeout (real cold load takes seconds)
        yield* backend.readinessProbe(spec).pipe(
          Effect.retry({ times: 60 }),
        )
        const healthy = yield* backend.isHealthy(spec)
        yield* backend.kill(server)
        return healthy
      }).pipe(Effect.scoped, Effect.provide(NodeContext.layer))

      const healthy = await Effect.runPromise(program)
      expect(healthy).toBe(true)
    }, 180_000)
  },
)
