import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { ModelClient } from "../model/client.js"
import type { ModelHandle } from "../model/handles.js"
import { DEFAULT_CORTEX_MODELS } from "../model/handles.js"
import { extractJson, parseOr, runHindbrain, runForebrain, type CortexRunnerConfig } from "./tiers.js"

const config: CortexRunnerConfig = {
  char: { name: "ada", dir: "/work/players/ada/me" },
  cadence: "real-time",
  models: DEFAULT_CORTEX_MODELS,
}

// A ModelClient that returns a fixed body regardless of input.
const fixedClient = (text: string): Layer.Layer<ModelClient> =>
  Layer.succeed(
    ModelClient,
    ModelClient.of({ complete: (_h: ModelHandle) => Effect.succeed({ text, raw: {} }) }),
  )

describe("extractJson / parseOr", () => {
  it("unwraps a ```json fence", () => {
    expect(JSON.parse(extractJson('```json\n{"a":1}\n```'))).toEqual({ a: 1 })
  })
  it("parseOr returns the fallback on garbage", () => {
    expect(parseOr("not json", { ok: false })).toEqual({ ok: false })
  })
})

describe("runHindbrain", () => {
  it("parses an escalate disposition from the model", async () => {
    const out = await Effect.runPromise(
      Effect.provide(
        runHindbrain(config, ["type: combat\n{}"], null),
        fixedClient('{"disposition":"escalate","emotionalWeight":"😰","reason":"under fire"}'),
      ),
    )
    expect(out.disposition).toBe("escalate")
  })

  it("falls back to accumulate on unparseable output (never silently discards)", async () => {
    const out = await Effect.runPromise(
      Effect.provide(runHindbrain(config, ["x"], null), fixedClient("the model rambled")),
    )
    expect(out.disposition).toBe("accumulate")
    expect(out.reason).toMatch(/parse/i)
  })
})

describe("runForebrain", () => {
  it("parses a headline", async () => {
    const out = await Effect.runPromise(
      Effect.provide(
        runForebrain(config, ["e1"], "{}", { background: "", values: "", diary: "" }, "😐"),
        fixedClient('{"headline":"Two PRs need review","sections":[],"whatChanged":"x","emotionalState":"😐","metrics":{}}'),
      ),
    )
    expect(out.headline).toContain("PRs")
  })
})
