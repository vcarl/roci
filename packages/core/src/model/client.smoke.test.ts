import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import { ModelClient, ModelClientLive } from "./client.js"
import type { ModelHandle } from "./handles.js"

// Point at a running OpenAI-compatible server, e.g.:
//   ROCI_MODEL_SMOKE_URL=http://127.0.0.1:8081/v1 \
//   ROCI_MODEL_SMOKE_MODEL=mlx-community/Qwen3.5-9B-4bit \
//   npx vitest run packages/core/src/model/client.smoke.test.ts
const url = process.env.ROCI_MODEL_SMOKE_URL
const model = process.env.ROCI_MODEL_SMOKE_MODEL ?? "local"

describe.skipIf(!url)("ModelClient against a real local endpoint", () => {
  it("returns a non-empty completion", async () => {
    const handle: ModelHandle = {
      tier: "hindbrain",
      provider: "openai-compatible",
      baseUrl: url as string,
      model,
      params: { maxTokens: 32, temperature: 0 },
    }
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const client = yield* ModelClient
          return yield* client.complete(handle, [
            { role: "user", content: "Reply with the single word: pong" },
          ])
        }),
        ModelClientLive,
      ),
    )
    expect(result.text.length).toBeGreaterThan(0)
  }, 60_000)
})
