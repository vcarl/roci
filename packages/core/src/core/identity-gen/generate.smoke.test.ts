import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { NodeContext } from "@effect/platform-node"
import { ModelClientLive } from "../../model/client.js"
import { ModelServiceLive, ModelBackendTag } from "../../services/ModelService.js"
import { makeMlxBackend } from "../../services/mlx-backend.js"
import { buildBackgroundPrompt } from "./prompts.js"
import { generateArtifact } from "./generate.js"

// Live end-to-end smoke: runs generateArtifact against a real conscious mlx tier.
// Gated: never runs in CI or the default suite — it requires mlx_lm.server on PATH
// and a conscious model server to be available.
//   ROCI_IDENTITY_SMOKE=1 pnpm vitest run packages/core/src/core/identity-gen/generate.smoke.test.ts

describe.skipIf(!process.env.ROCI_IDENTITY_SMOKE)(
  "generateArtifact (live conscious tier)",
  () => {
    it("produces non-trivial background prose", async () => {
      const modelBackendLayer = Layer.effect(ModelBackendTag, makeMlxBackend())
      const layers = Layer.mergeAll(
        ModelClientLive,
        ModelServiceLive.pipe(Layer.provide(modelBackendLayer)),
      )
      const prompt = buildBackgroundPrompt({
        characterName: "Smoke",
        characterDescription: "a wry archivist who hoards forbidden star-charts",
      })
      const text = await Effect.runPromise(
        generateArtifact("background", prompt).pipe(
          Effect.provide(layers),
          Effect.scoped,
          Effect.provide(NodeContext.layer),
        ),
      )
      expect(text.length).toBeGreaterThan(200)
    }, 240_000)
  },
)
