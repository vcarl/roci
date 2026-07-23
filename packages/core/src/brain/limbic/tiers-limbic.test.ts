import { describe, it, expect, afterEach, beforeEach } from "vitest"
import { createServer, type Server } from "node:http"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect, Layer } from "effect"
import { type ModelClient, ModelClientLive } from "../../model/client.js"
import { DEFAULT_CORTEX_MODELS } from "../../model/handles.js"
import { extractJson, parseOr } from "#brain/stem/parse.js"
import { runHindbrain, runForebrain } from "./tiers-limbic.js"
import type { ActivationRunnerConfig } from "#brain/stem/tier-config.js"
import type { UnifiedEvent } from "../../logging/events.js"
import { fixedClient, recordingService, recordingLog, silentLog } from "../../testing/model-test-layers.js"
import {
  setEpisodeLogRoot,
  setEpisodeTick,
  setEpisodeStep,
  resetEpisodeContext,
  beginEpisodeEpoch,
  captureEpisodeAttribution,
} from "../../logging/episodes.js"

const config: ActivationRunnerConfig = {
  char: { name: "ada", dir: "/work/players/ada/me" },
  cadence: "real-time",
  models: DEFAULT_CORTEX_MODELS,
}

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
    const reasoningConfig: ActivationRunnerConfig = {
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
        runForebrain(config, ["e1"], "{}", { background: "", values: "", diary: "", synthesis: "" }, "😐"),
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
        runForebrain(config, ["e1"], "{}", { background: "", values: "", diary: "", synthesis: "" }, "😐"),
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
        runForebrain(config, ["e1"], "{}", { background: "", values: "", diary: "", synthesis: "" }, "😐"),
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
        runForebrain(config, ["e1"], "{}", { background: "", values: "", diary: "", synthesis: "" }, "😐"),
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
        runForebrain(config, ["e1"], "{}", { background: "", values: "", diary: "", synthesis: "" }, "😐"),
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
        runForebrain(config, ["e1"], "{}", { background: "", values: "", diary: "", synthesis: "" }, "😐"),
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

describe("transition episodes — OODA tier calls", () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "episodes-tiers-limbic-"))
    setEpisodeLogRoot(root)
    resetEpisodeContext("ada")
    setEpisodeTick("ada", 7)
  })
  afterEach(() => {
    setEpisodeLogRoot(null)
    fs.rmSync(root, { recursive: true, force: true })
  })

  const transitionFile = () => path.join(root, "players", "ada", "logs", "episodes-transition.jsonl")
  const readTransitions = () =>
    fs.readFileSync(transitionFile(), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))

  it("orient appends a full-fidelity tier record: rendered prompt, parsed output, tick", async () => {
    await Effect.runPromise(
      Effect.provide(
        runForebrain(config, ["combat happened"], "{}", { background: "", values: "", diary: "", synthesis: "" }, "😰"),
        Layer.mergeAll(
          fixedClient('{"headline":"act now","sections":[],"whatChanged":"x","emotionalState":"😰","confidence":"high","metrics":{}}'),
          recordingService([]),
          silentLog,
        ),
      ),
    )
    const [rec] = readTransitions()
    expect(rec).toMatchObject({ type: "tier", phase: "orient", tick: 7, stepId: null })
    expect(rec.prompt).toContain("combat happened")
    expect(rec.output.headline).toBe("act now")
    // Default orient is the idle/plan path.
    expect(rec.orientKind).toBe("plan")
    // No run begun in this fixture → no epoch stamp on the record.
    expect(rec).not.toHaveProperty("epoch")
  })

  it("stamps the current run epoch on every tier record once a run has begun (scan-invariant carrier)", async () => {
    const epoch = beginEpisodeEpoch("ada") // clears the context…
    setEpisodeTick("ada", 7) // …so restamp the tick
    await Effect.runPromise(
      Effect.provide(
        runForebrain(config, ["evt"], "{}", { background: "", values: "", diary: "", synthesis: "" }, "😐"),
        Layer.mergeAll(
          fixedClient('{"headline":"h","sections":[],"whatChanged":"x","emotionalState":"😐","confidence":"low","metrics":{}}'),
          recordingService([]),
          silentLog,
        ),
      ),
    )
    const [rec] = readTransitions()
    expect(rec).toMatchObject({ type: "tier", phase: "orient", epoch })
  })

  it("stamps the orientKind discriminator: plan (default) vs steer", async () => {
    const layersFor = (text: string) => Layer.mergeAll(fixedClient(text), recordingService([]), silentLog)
    const okOrient = '{"headline":"h","sections":[],"whatChanged":"x","emotionalState":"😐","confidence":"low","metrics":{}}'
    // Steer path: the in-session orient produces a directive, not a plan.
    await Effect.runPromise(
      Effect.provide(
        runForebrain(config, ["evt"], "{}", { background: "", values: "", diary: "", synthesis: "" }, "😐", "", "", "steer"),
        layersFor(okOrient),
      ),
    )
    const [rec] = readTransitions()
    expect(rec).toMatchObject({ type: "tier", phase: "orient", orientKind: "steer" })
  })

  // Split from the original mixed "decide, evaluate, and diary each append
  // their phase; observe never does" case (cortex/tiers.test.ts) — the
  // decide/evaluate/diary half now lives in the sibling
  // tiers-conscious.test.ts (conscious tier, cortex layer). This half preserves the
  // negative-control assertion: observe (hindbrain) never appends a
  // transition record.
  it("observe never appends a transition record", async () => {
    await Effect.runPromise(
      Effect.provide(
        runHindbrain(config, "type: noise\n{}", null),
        Layer.mergeAll(
          fixedClient('{"disposition":"discard","emotionalWeight":"😐","drive":null,"weight":0,"reason":"x"}'),
          recordingService([]),
          silentLog,
        ),
      ),
    )
    expect(fs.existsSync(transitionFile())).toBe(false)
  })

  it("stamps a forked deliberation's tier record with the CAPTURED attribution, not the live context", async () => {
    const epoch = beginEpisodeEpoch("ada") // clears + issues the run epoch
    setEpisodeTick("ada", 5)
    setEpisodeStep("ada", null)
    const captured = captureEpisodeAttribution("ada") // { tick: 5, stepId: null, epoch }
    // The fast loop advances the live module-level context while the fork is in flight:
    setEpisodeTick("ada", 9)
    await Effect.runPromise(
      Effect.provide(
        runForebrain(
          config, ["evt"], "{}", { background: "", values: "", diary: "", synthesis: "" },
          "😐", "", "", "plan", captured,
        ),
        Layer.mergeAll(
          fixedClient('{"headline":"h","sections":[],"whatChanged":"x","emotionalState":"😐","confidence":"low","metrics":{}}'),
          recordingService([]), silentLog,
        ),
      ),
    )
    const [rec] = readTransitions()
    // Without the fix, emitTier reads the live tick (9); the capture must win.
    expect(rec).toMatchObject({ type: "tier", phase: "orient", tick: 5, epoch })
  })
})

describe("working-memory prompt variable (spec §2)", () => {
  const layers = (text: string) => Layer.mergeAll(fixedClient(text), recordingService([]), silentLog)

  it("orient renders the open-todo tree into the prompt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wm-tiers-limbic-"))
    setEpisodeLogRoot(root)
    resetEpisodeContext("ada")
    try {
      await Effect.runPromise(
        Effect.provide(
          runForebrain(config, ["evt"], "{}", { background: "", values: "", diary: "", synthesis: "" }, "😐", "", "- t1 WM_ORIENT_MARKER"),
          layers('{"headline":"h","sections":[],"whatChanged":"x","emotionalState":"😐","confidence":"low","metrics":{}}'),
        ),
      )
      const file = path.join(root, "players", "ada", "logs", "episodes-transition.jsonl")
      const [rec] = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
      expect(rec.prompt).toContain("Working Memory")
      expect(rec.prompt).toContain("- t1 WM_ORIENT_MARKER")
    } finally {
      setEpisodeLogRoot(null)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("memory-index prompt variable (synthesis)", () => {
  const layers = (text: string) => Layer.mergeAll(fixedClient(text), recordingService([]), silentLog)

  it("renders the SYNTHESIS memory-index block into the orient prompt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "synthesis-tiers-limbic-"))
    setEpisodeLogRoot(root)
    resetEpisodeContext("ada")
    try {
      await Effect.runPromise(
        Effect.provide(
          runForebrain(
            config,
            ["evt"],
            "{}",
            { background: "", values: "", diary: "", synthesis: "SYNTH_SELF_MODEL" },
            "😐",
          ),
          layers('{"headline":"h","sections":[],"whatChanged":"x","emotionalState":"😐","confidence":"low","metrics":{}}'),
        ),
      )
      const file = path.join(root, "players", "ada", "logs", "episodes-transition.jsonl")
      const [rec] = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
      expect(rec.prompt).toContain("Memory Index")
      expect(rec.prompt).toContain("SYNTH_SELF_MODEL")
    } finally {
      setEpisodeLogRoot(null)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

