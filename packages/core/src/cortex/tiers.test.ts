import { describe, it, expect, afterEach } from "vitest"
import { createServer, type Server } from "node:http"
import { Effect, Layer } from "effect"
import { ModelClient, ModelClientLive } from "../model/client.js"
import type { ModelHandle } from "../model/handles.js"
import { DEFAULT_CORTEX_MODELS } from "../model/handles.js"
import {
  extractJson,
  parseOr,
  runHindbrain,
  runForebrain,
  runConsciousDecide,
  runConsciousEvaluate,
  stripThinking,
  type CortexRunnerConfig,
} from "./tiers.js"
import type { OrientResult } from "../skills/types.js"
import { ModelService } from "../services/ModelService.js"
import { CharacterLog } from "../logging/log-writer.js"
import type { UnifiedEvent } from "../logging/events.js"

// A CharacterLog that records every emitted event's message, so tests can
// assert the raw forebrain text surfaced on a parse failure.
const recordingLog = (sink: UnifiedEvent[]): Layer.Layer<CharacterLog> =>
  Layer.succeed(
    CharacterLog,
    CharacterLog.of({
      emit: (_char, event) => {
        sink.push(event)
        return Effect.void
      },
    }),
  )

const silentLog = recordingLog([])

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

describe("runHindbrain — per-event appraisal", () => {
  it("parses + validates a full single-event result (drive/weight/interrupt)", async () => {
    const out = await Effect.runPromise(
      Effect.provide(
        runHindbrain(config, "type: combat\n{}", null),
        Layer.mergeAll(
          fixedClient(
            '{"disposition":"escalate","emotionalWeight":"😰","drive":"safety","weight":5,"interrupt":true,"reason":"under fire"}',
          ),
          recordingService([]),
          silentLog,
        ),
      ),
    )
    expect(out.disposition).toBe("escalate")
    expect(out.drive).toBe("safety")
    expect(out.weight).toBe(5)
    expect(out.interrupt).toBe(true)
  })

  it("clamps an out-of-range weight and validates an unknown drive to null", async () => {
    const out = await Effect.runPromise(
      Effect.provide(
        runHindbrain(config, "type: weird\n{}", null),
        Layer.mergeAll(
          fixedClient(
            '{"disposition":"accumulate","emotionalWeight":"😐","drive":"telepathy","weight":9,"reason":"x"}',
          ),
          recordingService([]),
          silentLog,
        ),
      ),
    )
    expect(out.weight).toBe(5) // clamped from 9
    expect(out.drive).toBeNull() // "telepathy" not in the core drive vocabulary
  })

  it("falls back to a safe accumulate object on unparseable output (never silently discards)", async () => {
    const out = await Effect.runPromise(
      Effect.provide(
        runHindbrain(config, "x", null),
        Layer.mergeAll(fixedClient("the model rambled"), recordingService([]), silentLog),
      ),
    )
    expect(out.disposition).toBe("accumulate")
    expect(out.weight).toBe(0)
    expect(out.drive).toBeNull()
    expect(out.interrupt).toBe(false)
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
        runHindbrain(reasoningConfig, "type: tick\n{}", null),
        Layer.mergeAll(layer, recordingService([]), silentLog),
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
          silentLog,
        ),
      ),
    )
    expect(out.headline).toContain("PRs")
  })

  it("parses a headline out of bare JSON wrapped in prose (no fallback)", async () => {
    const logs: UnifiedEvent[] = []
    const out = await Effect.runPromise(
      Effect.provide(
        runForebrain(config, ["e1"], "{}", { background: "", values: "", diary: "" }, "😐"),
        Layer.mergeAll(
          fixedClient(
            'Here is the situation:\n{"headline":"Build is red","sections":[],"whatChanged":"x","emotionalState":"😐","metrics":{}}\nLet me know.',
          ),
          recordingService([]),
          recordingLog(logs),
        ),
      ),
    )
    expect(out.headline).toBe("Build is red")
    // Success path must not spam the log with raw output.
    expect(logs.find((e) => e.kind === "system" && /raw/i.test((e as { message?: string }).message ?? ""))).toBeUndefined()
  })

  it("on parse failure, returns the fallback AND surfaces the raw forebrain text to the logger", async () => {
    const logs: UnifiedEvent[] = []
    const raw = "the forebrain rambled and never produced JSON"
    const out = await Effect.runPromise(
      Effect.provide(
        runForebrain(config, ["e1"], "{}", { background: "", values: "", diary: "" }, "😐"),
        Layer.mergeAll(fixedClient(raw), recordingService([]), recordingLog(logs)),
      ),
    )
    // Fallback object still returned (loop never crashes).
    expect(out.headline).toMatch(/parse failure/i)
    // Raw text was logged so the failure is diagnosable.
    const messages = logs
      .filter((e) => e.kind === "system")
      .map((e) => (e as { message?: string }).message ?? "")
    expect(messages.some((m) => m.includes(raw))).toBe(true)
    // The log should identify tier=forebrain and step=orient.
    expect(messages.some((m) => /forebrain/i.test(m) && /orient/i.test(m))).toBe(true)
  })

  it("fills confidence from the fallback when the model omits it (merge default = low)", async () => {
    const out = await Effect.runPromise(
      Effect.provide(
        runForebrain(config, ["e1"], "{}", { background: "", values: "", diary: "" }, "😐"),
        Layer.mergeAll(
          fixedClient('{"headline":"x","sections":[],"whatChanged":"y","emotionalState":"😐","metrics":{}}'),
          recordingService([]),
          silentLog,
        ),
      ),
    )
    expect(out.confidence).toBe("low")
  })
})

// Regression for the live cortex crash: the tolerant JSON extractor now
// recovers prose-wrapped JSON the old brittle parser threw on. If that
// recovered object is a valid OrientResult-ish object but MISSING `sections`
// (or has it as a non-array), runForebrain used to return it verbatim →
// downstream `orient.sections.map(...)` crashed with
//   "Cannot read properties of undefined (reading 'map')".
// runForebrain must always return a COMPLETE OrientResult: `sections` is
// always an array, never undefined and never a non-array.
describe("runForebrain — shape safety (live crash regression)", () => {
  const runWith = (raw: string) =>
    Effect.runPromise(
      Effect.provide(
        runForebrain(config, ["e1"], "{}", { background: "", values: "", diary: "" }, "😐"),
        Layer.mergeAll(fixedClient(raw), recordingService([]), silentLog),
      ),
    )

  it("backfills `sections` to an array when the parsed object omits it", async () => {
    // Valid JSON, prose-wrapped, but no `sections` key. tryParseJson now
    // SUCCEEDS on this — the merge must supply `sections: []`.
    const out = await runWith(
      'Here is the situation:\n{"headline":"Docked at station","whatChanged":"arrived"}\nThat is all.',
    )
    expect(out.headline).toBe("Docked at station")
    expect(Array.isArray(out.sections)).toBe(true)
    expect(out.sections).toEqual([])
    // It must be `.map`-able without throwing.
    expect(() => out.sections.map((s) => s.heading)).not.toThrow()
  })

  it("coerces a non-array `sections` (string) to a safe array", async () => {
    const out = await runWith('{"headline":"x","sections":"docked","whatChanged":"y"}')
    expect(Array.isArray(out.sections)).toBe(true)
    expect(out.sections).toEqual([])
  })

  it("coerces a null `sections` to a safe array", async () => {
    const out = await runWith('{"headline":"x","sections":null,"whatChanged":"y"}')
    expect(Array.isArray(out.sections)).toBe(true)
    expect(out.sections).toEqual([])
  })

  it("preserves a valid `sections` array", async () => {
    const out = await runWith(
      '{"headline":"x","sections":[{"id":"a","heading":"H","body":"B"}],"whatChanged":"y","emotionalState":"😐","metrics":{}}',
    )
    expect(out.sections).toEqual([{ id: "a", heading: "H", body: "B" }])
  })
})

// The decide path consumes the orient result's `sections` via `.map`. Even if
// a malformed OrientResult slips through (e.g. constructed directly), the
// decide builder must not throw on a non-array `sections`.
describe("runConsciousDecide — does not crash on malformed orient", () => {
  const decideWith = (orient: OrientResult) =>
    Effect.runPromise(
      Effect.provide(
        runConsciousDecide(config, orient, "no plan", "skills"),
        Layer.mergeAll(
          fixedClient('{"decision":"continue","reasoning":"steady"}'),
          recordingService([]),
          silentLog,
        ),
      ),
    )

  const base = {
    headline: "h",
    whatChanged: "w",
    emotionalState: "😐",
    confidence: "low" as const,
    metrics: {},
  }

  it("does not throw when sections is undefined", async () => {
    const out = await decideWith({ ...base, sections: undefined as never })
    expect(out.decision).toBe("continue")
  })

  it("does not throw when sections is a non-array", async () => {
    const out = await decideWith({ ...base, sections: "docked" as never })
    expect(out.decision).toBe("continue")
  })
})

// Regression: a small conscious model can emit `{"transition":"replan"}` — a
// bare ENUM STRING where the schema wants `{transition:"replan",...}`. The merge
// keeps the string, so downstream `evalResult.transition.transition` is
// undefined and every transition branch falls through (silently wrong: the loop
// neither replans nor terminates nor waits — it falls into the next_step else).
// runConsciousEvaluate must normalize `transition` so it is ALWAYS a valid
// `{transition: <enum>}` object before it reaches the loop.
describe("runConsciousEvaluate — transition normalization", () => {
  const evalInput = {
    task: "t",
    goal: "g",
    successCondition: "c",
    ticksBudgeted: 4,
    ticksConsumed: 2,
    executionReport: "did stuff",
    stateDiff: "diff",
    conditionCheck: "checked",
    emotionalState: "😐",
    remainingSteps: "None.",
  }

  const evalWith = (raw: string) =>
    Effect.runPromise(
      Effect.provide(
        runConsciousEvaluate(config, evalInput),
        Layer.mergeAll(fixedClient(raw), recordingService([]), silentLog),
      ),
    )

  it("coerces a bare-string transition (\"replan\") to a valid object", async () => {
    const out = await evalWith(
      '{"judgment":"failed","reasoning":"r","transition":"replan"}',
    )
    expect(out.transition).toEqual({ transition: "replan" })
    // Downstream `t.transition` reads must see the enum, not undefined.
    expect(out.transition.transition).toBe("replan")
  })

  it("coerces a bare-string \"next_step\" transition to a valid object", async () => {
    const out = await evalWith(
      '{"judgment":"succeeded","reasoning":"r","transition":"next_step"}',
    )
    expect(out.transition.transition).toBe("next_step")
  })

  it("defaults to next_step when transition is missing entirely", async () => {
    const out = await evalWith('{"judgment":"succeeded","reasoning":"r"}')
    expect(out.transition.transition).toBe("next_step")
  })

  it("defaults to next_step when transition is an unrecoverable shape (number)", async () => {
    const out = await evalWith(
      '{"judgment":"failed","reasoning":"r","transition":7}',
    )
    expect(out.transition.transition).toBe("next_step")
  })

  it("preserves a proper object transition (replan with reason)", async () => {
    const out = await evalWith(
      '{"judgment":"failed","reasoning":"r","transition":{"transition":"replan","reason":"stuck"}}',
    )
    expect(out.transition).toEqual({ transition: "replan", reason: "stuck" })
  })

  it("preserves a proper object transition (terminate with summary)", async () => {
    const out = await evalWith(
      '{"judgment":"succeeded","reasoning":"r","transition":{"transition":"terminate","summary":"done"}}',
    )
    expect(out.transition.transition).toBe("terminate")
  })

  it("falls back to a valid transition object on a total parse miss", async () => {
    const out = await evalWith("the model rambled, no json")
    expect(out.transition.transition).toBe("next_step")
  })
})

describe("callTier routes through ModelService.withTier", () => {
  it("wraps the hindbrain call with withTier('hindbrain')", async () => {
    const wrapped: string[] = []
    await Effect.runPromise(
      Effect.provide(
        runHindbrain(config, "type: tick\n{}", null),
        Layer.mergeAll(
          fixedClient('{"disposition":"discard","emotionalWeight":"😐","reason":"x"}'),
          recordingService(wrapped),
          silentLog,
        ),
      ),
    )
    expect(wrapped).toEqual(["hindbrain"])
  })
})

describe("callTier emits a full prompt+response exchange", () => {
  it("emits a cortex exchange with the full response on the hindbrain success path", async () => {
    const logs: UnifiedEvent[] = []
    const body = '{"disposition":"discard","emotionalWeight":"😐","reason":"noise"}'
    await Effect.runPromise(
      Effect.provide(
        runHindbrain(config, "type: tick\n{}", null),
        Layer.mergeAll(fixedClient(body), recordingService([]), recordingLog(logs)),
      ),
    )
    const ex = logs.find((e) => e.kind === "exchange") as Extract<UnifiedEvent, { kind: "exchange" }> | undefined
    expect(ex).toBeDefined()
    expect(ex!.channel).toBe("cortex")
    expect(ex!.step).toBe("observe")
    expect(ex!.prompt.length).toBeGreaterThan(0)
    expect(ex!.response).toBe(body) // full model output, verbatim
  })
})

describe("runForebrain — full (untruncated) raw output on parse failure", () => {
  it("logs the entire raw output, with no [truncated] marker, when it exceeds the old 2000-char cap", async () => {
    const logs: UnifiedEvent[] = []
    const raw = "NO-JSON " + "Q".repeat(3000) // > old RAW_FOREBRAIN_LOG_LIMIT
    await Effect.runPromise(
      Effect.provide(
        runForebrain(config, ["e1"], "{}", { background: "", values: "", diary: "" }, "😐"),
        Layer.mergeAll(fixedClient(raw), recordingService([]), recordingLog(logs)),
      ),
    )
    const msg = logs
      .filter((e) => e.kind === "system")
      .map((e) => (e as { message?: string }).message ?? "")
      .find((m) => /parse failure/i.test(m))
    expect(msg).toBeDefined()
    expect(msg!).toContain(raw) // FULL raw present
    expect(msg!).not.toMatch(/truncated/i)
  })
})

describe("stripThinking", () => {
  it("returns only the trailing prose after a single <think> preamble", () => {
    expect(stripThinking("<think>weighing options</think>Today went well.")).toBe(
      "Today went well.",
    )
  })

  it("returns the full trimmed text when there is no closing tag", () => {
    expect(stripThinking("  Just a plain reflection.  ")).toBe("Just a plain reflection.")
  })

  it("returns everything after the LAST </think> when multiple blocks exist", () => {
    expect(
      stripThinking("<think>first</think>noise<think>second</think>The final entry."),
    ).toBe("The final entry.")
  })

  it("trims leading/trailing whitespace around the extracted prose", () => {
    expect(stripThinking("<think>hmm</think>\n  spaced out  \n")).toBe("spaced out")
  })
})
