import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { generateArtifact, EmptyGenerationError } from "./generate.js"
import { fixedClient, recordingService } from "../../testing/model-test-layers.js"

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
