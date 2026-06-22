import { describe, it, expect, afterEach } from "vitest"
import { createServer, type Server } from "node:http"
import { Effect, Layer } from "effect"
import { ModelClient, ModelClientLive } from "../model/client.js"
import type { ModelHandle } from "../model/handles.js"
import { DEFAULT_CORTEX_MODELS } from "../model/handles.js"
import { extractJson, parseOr, runHindbrain, runForebrain, type CortexRunnerConfig } from "./tiers.js"
import { ModelService } from "../services/ModelService.js"

// A ModelService whose withTier records the tier it wrapped, then runs the
// effect unchanged — lets tests assert callTier routed through withTier.
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
        Layer.mergeAll(
          fixedClient('{"disposition":"escalate","emotionalWeight":"😰","reason":"under fire"}'),
          recordingService([]),
        ),
      ),
    )
    expect(out.disposition).toBe("escalate")
  })

  it("falls back to accumulate on unparseable output (never silently discards)", async () => {
    const out = await Effect.runPromise(
      Effect.provide(
        runHindbrain(config, ["x"], null),
        Layer.mergeAll(fixedClient("the model rambled"), recordingService([])),
      ),
    )
    expect(out.disposition).toBe("accumulate")
    expect(out.reason).toMatch(/parse/i)
  })
})

// Regression for Bug B: a reasoning model (the hindbrain default) under the real
// triage prompt spends its budget on `message.reasoning` and returns empty
// `content`. Before the fix the real client threw `missing
// choices[0].message.content` → loop fatal on tick 1. This drives runHindbrain
// through the REAL ModelClientLive against a mock server emitting that exact
// reasoning-only shape, and asserts the disposition is parsed (loop survives).
describe("runHindbrain — reasoning-only response (Bug B regression)", () => {
  let server: Server | null = null

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
  })

  const reasoningOnlyClientAt = async (): Promise<{ layer: Layer.Layer<ModelClient>; baseUrl: string }> => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          // No `content` — the model burned its budget thinking. The usable
          // answer is in `reasoning`.
          choices: [
            { message: { role: "assistant", reasoning: '{"disposition":"discard","emotionalWeight":"😐","reason":"noise"}' } },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 200 },
        }),
      )
    })
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve))
    const port = (server!.address() as { port: number }).port
    return { layer: ModelClientLive, baseUrl: `http://127.0.0.1:${port}/v1` }
  }

  it("does not fatal; parses the disposition out of message.reasoning", async () => {
    const { layer, baseUrl } = await reasoningOnlyClientAt()
    const reasoningConfig: CortexRunnerConfig = {
      ...config,
      models: {
        ...DEFAULT_CORTEX_MODELS,
        hindbrain: { ...DEFAULT_CORTEX_MODELS.hindbrain, baseUrl },
      },
    }
    const out = await Effect.runPromise(
      Effect.provide(
        runHindbrain(reasoningConfig, ["type: tick\n{}"], null),
        Layer.mergeAll(layer, recordingService([])),
      ),
    )
    expect(out.disposition).toBe("discard")
  })
})

describe("runForebrain", () => {
  it("parses a headline", async () => {
    const out = await Effect.runPromise(
      Effect.provide(
        runForebrain(config, ["e1"], "{}", { background: "", values: "", diary: "" }, "😐"),
        Layer.mergeAll(
          fixedClient('{"headline":"Two PRs need review","sections":[],"whatChanged":"x","emotionalState":"😐","metrics":{}}'),
          recordingService([]),
        ),
      ),
    )
    expect(out.headline).toContain("PRs")
  })
})

describe("callTier routes through ModelService.withTier", () => {
  it("wraps the hindbrain call with withTier('hindbrain')", async () => {
    const wrapped: string[] = []
    await Effect.runPromise(
      Effect.provide(
        runHindbrain(config, ["type: tick\n{}"], null),
        Layer.mergeAll(
          fixedClient('{"disposition":"discard","emotionalWeight":"😐","reason":"x"}'),
          recordingService(wrapped),
        ),
      ),
    )
    expect(wrapped).toEqual(["hindbrain"])
  })
})
