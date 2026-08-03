import { describe, it, expect } from "vitest"
import { Effect, Layer, Fiber, TestClock, TestContext } from "effect"
import {
  buildAdjudicatePrompt,
  runSalienceSweep,
  MAX_CONSECUTIVE_MODEL_FAILURES,
  SWEEP_DEADLINE_MS,
  SWEEP_ROW_CAP,
} from "./salience-sweep.js"
import { buildAxisSpecs } from "../../../../core/salience.js"
import { LongtermStore, type PendingMemory } from "./longterm-store.js"
import { ModelClient } from "../../../../model/client.js"
import { ModelError } from "../../../../model/errors.js"
import { DEFAULT_CORTEX_MODELS } from "../../../../model/handles.js"
import type { ActivationRunnerConfig } from "#brain/stem/tier-config.js"
import { recordingService, silentLog } from "../../../../testing/model-test-layers.js"

const AXES = buildAxisSpecs(
  "- safety — your physical integrity\n- voyage — progress toward your destination",
  "😫 😮‍💨 😐 🤩 🚀 # burdened → exhilarated",
)

describe("the sweep's three bounds", () => {
  it("caps ROWS per sweep, at one documented site", () => {
    expect(SWEEP_ROW_CAP).toBe(10)
  })

  it("caps WALL-CLOCK per sweep, under the reflection budgets it shares a seam with", () => {
    expect(SWEEP_DEADLINE_MS).toBe(300_000)
    // dream.ts: CULL_TURN_TIMEOUT_MS 360s, REFLECTION_TURN_TIMEOUT_MS 480s. The
    // most deferrable stage in reflection must never be the longest one.
    expect(SWEEP_DEADLINE_MS).toBeLessThan(360_000)
  })

  it("stops after a run of consecutive model failures", () => {
    expect(MAX_CONSECUTIVE_MODEL_FAILURES).toBe(3)
  })
})

describe("buildAdjudicatePrompt", () => {
  const base = {
    text: "Hull scraped on the debris ring; nothing lost.",
    axes: AXES,
    dimsA: { safety: 0.31, "burdened-exhilarated": -0.12 },
    dimsC: { safety: 0.8, "burdened-exhilarated": -0.4 },
  }

  it("carries the memory text, the axis list, and BOTH candidate vectors", () => {
    const p = buildAdjudicatePrompt(base)
    expect(p).toContain("Hull scraped on the debris ring")
    expect(p).toContain("safety")
    expect(p).toContain("burdened-exhilarated")
    expect(p).toContain(JSON.stringify(base.dimsA))
    expect(p).toContain(JSON.stringify(base.dimsC))
  })

  it("labels the two candidates by WHAT THEY ARE, not by letter", () => {
    const p = buildAdjudicatePrompt(base).toLowerCase()
    expect(p).toContain("similarity")
    expect(p).toContain("wrote the memory")
  })

  it("says plainly that the two candidates may be ignored", () => {
    expect(buildAdjudicatePrompt(base).toLowerCase()).toContain("ignore")
  })

  it("states the two ranges and the sign convention", () => {
    const p = buildAdjudicatePrompt(base)
    expect(p).toContain("0.0 (does not bear on it) to 1.0")
    expect(p).toContain('-1.0 (hard toward "burdened")')
  })

  it("says explicitly when the MECHANICAL pass produced no reading at all", () => {
    // `dims_a = '{}'` is the memory CLI's signal that the A stage was inert — no
    // embedding, no gloss vectors. Rendering it as a scored `{}` would tell the
    // adjudicator the similarity pass looked and found nothing, which is untrue.
    const p = buildAdjudicatePrompt({ ...base, dimsA: {} })
    expect(p.toLowerCase()).toContain("no reading at all")
    expect(p).not.toContain("{}")
    // Still labelled by what it is, so the rubric paragraph below still lands.
    expect(p.toLowerCase()).toContain("similarity")
  })

  it("says explicitly when there was no producer vector at all", () => {
    const p = buildAdjudicatePrompt({ ...base, dimsC: null })
    expect(p.toLowerCase()).toContain("no second opinion")
    expect(p).not.toContain("null")
  })

  it("asks for a bare JSON object and nothing else", () => {
    const p = buildAdjudicatePrompt(base)
    expect(p).toContain("Respond with ONLY")
    expect(p).toContain("{")
  })

  it("does not throw on an empty axis list or empty vectors", () => {
    expect(() =>
      buildAdjudicatePrompt({ text: "t", axes: [], dimsA: {}, dimsC: null }),
    ).not.toThrow()
  })
})

// ── runSalienceSweep ─────────────────────────────────────────
//
// These are WIRING tests: each one fails if the production line it names is
// deleted. The sweep's whole job is plumbing — pull the axes from config, hand
// the model BOTH candidate vectors separately, sanitize the answer, write it
// over the base — and every one of those steps is a line that would otherwise
// vanish silently.

const char = { name: "ada", root: "/work/players/ada" }

const config = (axes = AXES): ActivationRunnerConfig => ({
  char,
  cadence: "planned-action",
  models: DEFAULT_CORTEX_MODELS,
  axes,
})

/** A ModelClient that records every prompt it is handed and replies from a queue. */
function capturingClient(replies: string[]) {
  const prompts: string[] = []
  const layer = Layer.succeed(
    ModelClient,
    ModelClient.of({
      complete: (_h, messages) => {
        prompts.push(String(messages[0]?.content ?? ""))
        const next = replies.length > 1 ? replies.shift()! : (replies[0] ?? "{}")
        return Effect.succeed({ text: next, raw: {} })
      },
    }),
  )
  return { layer, prompts }
}

/** A ModelClient that always fails, to exercise the leave-it-at-`base` path. */
const failingClient = Layer.succeed(
  ModelClient,
  ModelClient.of({
    complete: (_h) =>
      Effect.fail(
        new ModelError({ tier: "forebrain", model: "m", baseUrl: "http://x", reason: "boom" }),
      ),
  }),
)

function makeStore(opts: {
  rows?: ReadonlyArray<PendingMemory>
  failPending?: boolean
  failAdjudicateIds?: ReadonlyArray<number>
  throwOnPending?: boolean
} = {}) {
  const pendingCalls: Array<{ containerId: string; n?: number }> = []
  const writes: Array<{ id: number; dims: Record<string, number> }> = []
  const layer = Layer.succeed(
    LongtermStore,
    LongtermStore.of({
      readMark: () => Effect.succeed(null),
      writeMark: () => Effect.void,
      promote: () => Effect.succeed(0),
      remember: () => Effect.void,
      recall: () => Effect.succeed([]),
      pending: (containerId, _c, n) => {
        if (opts.throwOnPending) throw new Error("pending exploded")
        pendingCalls.push({ containerId, n })
        return opts.failPending
          ? Effect.fail(new Error("pending boom"))
          : Effect.succeed(opts.rows ?? [])
      },
      adjudicate: (_id, _c, id, dims) =>
        opts.failAdjudicateIds?.includes(id)
          ? Effect.fail(new Error("adjudicate boom"))
          : Effect.sync(() => {
              writes.push({ id, dims })
            }),
    }),
  )
  return { layer, pendingCalls, writes }
}

const ROW: PendingMemory = {
  id: 7,
  text: "Hull scraped on the debris ring; nothing lost.",
  dimsA: { safety: 0.31, "burdened-exhilarated": -0.12 },
  dimsC: { safety: 0.8, "burdened-exhilarated": -0.4 },
}

const runSweep = (
  layers: Layer.Layer<never, never, never> | Layer.Layer<unknown, never, never>,
  cfg: ActivationRunnerConfig = config(),
) =>
  Effect.runPromise(
    runSalienceSweep({ char, containerId: "c1", config: cfg }).pipe(
      Effect.provide(layers as Layer.Layer<never>),
    ) as Effect.Effect<{ adjudicated: number; skipped: number }, never, never>,
  )

describe("runSalienceSweep", () => {
  it("asks the store for base-stage rows, capped at SWEEP_ROW_CAP", async () => {
    const store = makeStore({ rows: [] })
    const client = capturingClient(['{"safety":0.5}'])
    const out = await runSweep(Layer.mergeAll(store.layer, client.layer, recordingService([]), silentLog))
    expect(store.pendingCalls).toEqual([{ containerId: "c1", n: SWEEP_ROW_CAP }])
    expect(out).toEqual({ adjudicated: 0, skipped: 0 })
    // No rows → no model call at all.
    expect(client.prompts.length).toBe(0)
  })

  it("hands the model A and C SEPARATELY — never their mean", async () => {
    const store = makeStore({ rows: [ROW] })
    const client = capturingClient(['{"safety":0.6,"burdened-exhilarated":-0.3}'])
    await runSweep(Layer.mergeAll(store.layer, client.layer, recordingService([]), silentLog))
    expect(client.prompts.length).toBe(1)
    const p = client.prompts[0]
    expect(p).toContain(JSON.stringify(ROW.dimsA))
    expect(p).toContain(JSON.stringify(ROW.dimsC))
    // The mean of A and C for safety is 0.555 — if the prompt ever carried the
    // merged base instead of the two inputs, this is the number that would show up.
    expect(p).not.toContain("0.555")
    // The row's own text and the config's axis vocabulary both reach the model.
    expect(p).toContain(ROW.text)
    expect(p).toContain("burdened-exhilarated")
    expect(p).toContain("voyage")
  })

  it("says 'no second opinion' when the pathway had no producer vector", async () => {
    const store = makeStore({ rows: [{ ...ROW, dimsC: null }] })
    const client = capturingClient(['{"safety":0.6}'])
    await runSweep(Layer.mergeAll(store.layer, client.layer, recordingService([]), silentLog))
    expect(client.prompts[0].toLowerCase()).toContain("no second opinion")
  })

  it("runs on the FOREBRAIN tier, one call per row", async () => {
    const tiers: string[] = []
    const rows = [ROW, { ...ROW, id: 8 }, { ...ROW, id: 9 }]
    const store = makeStore({ rows })
    const client = capturingClient(['{"safety":0.6}'])
    const out = await runSweep(Layer.mergeAll(store.layer, client.layer, recordingService(tiers), silentLog))
    expect(tiers).toEqual(["forebrain", "forebrain", "forebrain"])
    expect(client.prompts.length).toBe(3)
    expect(out).toEqual({ adjudicated: 3, skipped: 0 })
  })

  it("SANITIZES the adjudicator's answer before it supersedes the base", async () => {
    const store = makeStore({ rows: [ROW] })
    // Out of range on a unipolar axis, out of range on a bipolar axis, plus an
    // axis the model invented. Only the clamped, in-vocabulary keys may be written.
    const client = capturingClient([
      '{"safety": 5, "burdened-exhilarated": -9, "telepathy": 1, "voyage": null}',
    ])
    const out = await runSweep(Layer.mergeAll(store.layer, client.layer, recordingService([]), silentLog))
    expect(store.writes).toEqual([{ id: 7, dims: { safety: 1, "burdened-exhilarated": -1 } }])
    expect(out).toEqual({ adjudicated: 1, skipped: 0 })
  })

  it("leaves the row at `base` when the answer does not parse", async () => {
    const store = makeStore({ rows: [ROW] })
    const client = capturingClient(["I'm sorry Dave, I'm afraid I can't do that"])
    const out = await runSweep(Layer.mergeAll(store.layer, client.layer, recordingService([]), silentLog))
    expect(store.writes).toEqual([])
    expect(out).toEqual({ adjudicated: 0, skipped: 1 })
  })

  it("never writes an EMPTY vector over a real base", async () => {
    const store = makeStore({ rows: [ROW] })
    // All-zero collapses to `{}` in the shared sanitizer — writing that would turn
    // a scored memory neutral on the strength of a bad answer.
    const client = capturingClient(['{"safety": 0, "burdened-exhilarated": 0}'])
    const out = await runSweep(Layer.mergeAll(store.layer, client.layer, recordingService([]), silentLog))
    expect(store.writes).toEqual([])
    expect(out).toEqual({ adjudicated: 0, skipped: 1 })
  })

  it("survives a model failure and keeps going through the rest of the batch", async () => {
    const store = makeStore({ rows: [ROW, { ...ROW, id: 8 }] })
    const out = await runSweep(Layer.mergeAll(store.layer, failingClient, recordingService([]), silentLog))
    expect(store.writes).toEqual([])
    expect(out).toEqual({ adjudicated: 0, skipped: 2 })
  })

  it("survives a failed write on one row and still adjudicates the next", async () => {
    const store = makeStore({ rows: [ROW, { ...ROW, id: 8 }], failAdjudicateIds: [7] })
    const client = capturingClient(['{"safety":0.6}'])
    const out = await runSweep(Layer.mergeAll(store.layer, client.layer, recordingService([]), silentLog))
    expect(store.writes.map((w) => w.id)).toEqual([8])
    expect(out).toEqual({ adjudicated: 1, skipped: 1 })
  })

  it("survives a store that cannot list pending rows", async () => {
    const store = makeStore({ failPending: true })
    const client = capturingClient(['{"safety":0.6}'])
    const out = await runSweep(Layer.mergeAll(store.layer, client.layer, recordingService([]), silentLog))
    expect(out).toEqual({ adjudicated: 0, skipped: 0 })
    expect(client.prompts.length).toBe(0)
  })

  it("survives a DEFECT — a sweep problem must never take down reflection", async () => {
    const store = makeStore({ throwOnPending: true })
    const client = capturingClient(['{"safety":0.6}'])
    const out = await runSweep(Layer.mergeAll(store.layer, client.layer, recordingService([]), silentLog))
    expect(out).toEqual({ adjudicated: 0, skipped: 0 })
  })

  it("stops after MAX_CONSECUTIVE_MODEL_FAILURES rather than grinding the batch", async () => {
    // Product intent: a wedged tier does not un-wedge mid-sweep. The row cap
    // bounds the sweep in ROWS; this bounds the damage a dead tier can do inside
    // that cap, for the fast-failure mode the wall-clock deadline is blind to.
    const rows = Array.from({ length: 8 }, (_, i) => ({ ...ROW, id: 100 + i }))
    const store = makeStore({ rows })
    let calls = 0
    const counting = Layer.succeed(
      ModelClient,
      ModelClient.of({
        complete: () => {
          calls += 1
          return Effect.fail(
            new ModelError({ tier: "forebrain", model: "m", baseUrl: "http://x", reason: "wedged" }),
          )
        },
      }),
    )
    const out = await runSweep(Layer.mergeAll(store.layer, counting, recordingService([]), silentLog))
    expect(calls).toBe(MAX_CONSECUTIVE_MODEL_FAILURES)
    expect(store.writes).toEqual([])
    // Every unreached row is still accounted for — nothing is lost, all 8 keep
    // their base vector for the next sweep.
    expect(out).toEqual({ adjudicated: 0, skipped: 8 })
  })

  it("resets the failure run on any success — an isolated blip does not end the sweep", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ ...ROW, id: 200 + i }))
    const store = makeStore({ rows })
    // fail, ok, fail, fail, fail → the run only reaches 3 AFTER the success.
    const script: Array<string | null> = [null, '{"safety":0.6}', null, null, null]
    let calls = 0
    const scripted = Layer.succeed(
      ModelClient,
      ModelClient.of({
        complete: () => {
          const next = script[calls] ?? null
          calls += 1
          return next === null
            ? Effect.fail(
                new ModelError({ tier: "forebrain", model: "m", baseUrl: "http://x", reason: "flap" }),
              )
            : Effect.succeed({ text: next, raw: {} })
        },
      }),
    )
    const out = await runSweep(Layer.mergeAll(store.layer, scripted, recordingService([]), silentLog))
    expect(calls).toBe(5)
    expect(store.writes.map((w) => w.id)).toEqual([201])
    expect(out).toEqual({ adjudicated: 1, skipped: 7 })
  })

  it("stops at the wall-clock DEADLINE and keeps the work it already committed", async () => {
    // Product intent: the row cap bounds the sweep in rows but not in time —
    // `withTier` wraps every per-phase call in acquireReady, whose own caveat is
    // ~2300s of uncapped backoff PER ROW. A wedged tier must cost one bounded
    // window, not one per row. Hermetic: virtual clock, no real sleeping.
    const rows = [ROW, { ...ROW, id: 8 }, { ...ROW, id: 9 }]
    const store = makeStore({ rows })
    let calls = 0
    const hangsAfterFirst = Layer.succeed(
      ModelClient,
      ModelClient.of({
        complete: () => {
          calls += 1
          return calls === 1 ? Effect.succeed({ text: '{"safety":0.6}', raw: {} }) : Effect.never
        },
      }),
    )
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          runSalienceSweep({ char, containerId: "c1", config: config() }),
        )
        // Let the fiber reach the hanging second call, then blow past the budget.
        yield* TestClock.adjust("1 millis")
        yield* TestClock.adjust(`${SWEEP_DEADLINE_MS} millis`)
        return yield* Fiber.join(fiber)
      }).pipe(
        Effect.provide(
          Layer.mergeAll(store.layer, hangsAfterFirst, recordingService([]), silentLog),
        ),
        Effect.provide(TestContext.TestContext),
      ) as Effect.Effect<{ adjudicated: number; skipped: number }, never, never>,
    )
    // Row 1's write survives the interruption; rows 2 and 3 stay at `base`.
    expect(store.writes.map((w) => w.id)).toEqual([7])
    expect(out).toEqual({ adjudicated: 1, skipped: 2 })
  })

  it("does nothing at all when the character has no axis vocabulary", async () => {
    const store = makeStore({ rows: [ROW] })
    const client = capturingClient(['{"safety":0.6}'])
    const out = await runSweep(
      Layer.mergeAll(store.layer, client.layer, recordingService([]), silentLog),
      config([]),
    )
    // Not even a `pending` call: with no vocabulary there is nothing to grade
    // against, and the rows keep their mechanical vector for a later sweep.
    expect(store.pendingCalls).toEqual([])
    expect(client.prompts.length).toBe(0)
    expect(out).toEqual({ adjudicated: 0, skipped: 0 })
  })
})
