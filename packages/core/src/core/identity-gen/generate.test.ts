import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { ModelClient } from "../../model/client.js"
import { ModelService } from "../../services/ModelService.js"
import type { ModelHandle } from "../../model/handles.js"
import { generateArtifact, EmptyGenerationError } from "./generate.js"

const fixedClient = (text: string): Layer.Layer<ModelClient> =>
  Layer.succeed(ModelClient, ModelClient.of({ complete: (_h: ModelHandle) => Effect.succeed({ text, raw: {} }) }))

const recordingService = (sink: string[]): Layer.Layer<ModelService> =>
  Layer.succeed(
    ModelService,
    ModelService.of({
      withTier: (tier) => (effect) => {
        sink.push(tier)
        return effect as never
      },
    }),
  )

describe("generateArtifact", () => {
  it("returns trimmed text and routes through the conscious tier", async () => {
    const tiers: string[] = []
    const out = await Effect.runPromise(
      Effect.provide(
        generateArtifact("background", "prompt"),
        Layer.mergeAll(fixedClient("  hello world  "), recordingService(tiers)),
      ),
    )
    expect(out).toBe("hello world")
    expect(tiers).toEqual(["conscious"])
  })

  it("fails with EmptyGenerationError on empty content", async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        generateArtifact("values", "prompt"),
        Layer.mergeAll(fixedClient("   "), recordingService([])),
      ).pipe(Effect.either),
    )
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") expect(result.left).toBeInstanceOf(EmptyGenerationError)
  })
})
