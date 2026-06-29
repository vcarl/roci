import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import { SpaceMoltPromptBuilderLive } from "./prompt-builder.js"
import { PromptBuilderTag } from "@roci/core/core/prompt-builder.js"

describe("SpaceMoltPromptBuilderLive — systemPrompt composes the discovery rubric", () => {
  it("includes the rubric and fills SpaceMolt slots", async () => {
    const prompt = await Effect.runPromise(
      Effect.gen(function* () {
        const builder = yield* PromptBuilderTag
        return builder.systemPrompt("select", "")
      }).pipe(Effect.provide(SpaceMoltPromptBuilderLive)),
    )
    // Rubric composed in (distinctive line from discovery-rubric.md).
    expect(prompt).toContain("Discovering your world")
    // Slot filled with the SpaceMolt-specific value (proves composition + slot fill).
    expect(prompt).toContain("`spacemolt` CLI")
  })
})
