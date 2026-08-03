import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { Context, Effect, Layer } from "effect"
import { describe, it, expect } from "vitest"
import { LongtermStore, type MemoryHit } from "./longterm-store.js"
import { CharacterFs, type CharacterConfig } from "../../../../services/CharacterFs.js"
import type { OrientResult, DecideResult, EvaluateResult } from "../../../../skills/types.js"
import { RERANK_OVERFETCH, SCORER_VERSION } from "./memory-rank.js"
import { clearAxisVocabulary, publishAxisVocabulary } from "./scoring-context.js"
import { TEMPLATE_SALIENCE } from "../../../../core/salience.js"
import {
  RECALL_SITES,
  RECALL_TELEMETRY_FILE,
  type RecallTelemetryRecord,
} from "../../../../logging/recall-telemetry.js"
import {
  RECALL_USAGE_FILE,
  recordRecallUsage,
  resetPendingRecalls,
  type RecallUsageRecord,
} from "../../../../logging/recall-usage.js"
import {
  observeMemories,
  orientMemories,
  decideMemories,
  evaluateMemories,
  formatRecall,
  formatAge,
  orientQuery,
  MemoryGateway,
  MemoryGatewayLive,
} from "./memory-gateway.js"

// A real (empty) root: recall now appends telemetry under logsDir(char), and a
// character with no root would make every recall test log a swallowed write
// failure. No mood.json is written here, so readMood still degrades to `{}`.
const SUITE_ROOT = mkdtempSync(path.join(tmpdir(), "roci-gw-"))
const char = { name: "ada", root: path.join(SUITE_ROOT, "ada") } as CharacterConfig

function fakeStore(opts: { hits?: MemoryHit[]; fail?: boolean } = {}) {
  const remembered: Array<{ text: string; source: string; tags: ReadonlyArray<string> }> = []
  const recalledKs: number[] = []
  const layer = Layer.succeed(
    LongtermStore,
    LongtermStore.of({
      readMark: () => Effect.succeed(null),
      writeMark: () => Effect.void,
      promote: () => Effect.succeed(0),
      remember: (_id, _char, entry) =>
        opts.fail ? Effect.fail(new Error("boom")) : Effect.sync(() => void remembered.push(entry)),
      recall: (_id, _char, _q, o) =>
        opts.fail
          ? Effect.fail(new Error("boom"))
          : Effect.sync(() => {
              if (o?.k !== undefined) recalledKs.push(o.k)
              return opts.hits ?? []
            }),
      pending: () => Effect.succeed([]),
      adjudicate: () => Effect.void,
    }),
  )
  return { layer, remembered, recalledKs }
}

/**
 * Minimal CharacterFs fake: the gateway only calls `readSalience`. Cast a partial
 * object to the tag's service type — no need to stub every method for these tests.
 */
function fakeCharFs(salienceMd: string = TEMPLATE_SALIENCE) {
  return Layer.succeed(
    CharacterFs,
    { readSalience: () => Effect.succeed(salienceMd) } as unknown as Context.Tag.Service<typeof CharacterFs>,
  )
}

const run = <A>(store: ReturnType<typeof fakeStore>, program: Effect.Effect<A, never, MemoryGateway>) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(MemoryGatewayLive.pipe(Layer.provide(Layer.merge(store.layer, fakeCharFs())))),
    ),
  )

describe("pure capture extractors", () => {
  it("observeMemories carries the observe tier's OWN axis vector as the producer (C) dims", () => {
    const keep = {
      disposition: "accumulate" as const,
      emotionalWeight: "😟",
      drive: "safety",
      weight: 4,
      reason: "hull scraped",
      salience: { safety: 0.8, "burdened-exhilarated": -0.5 },
    }
    expect(observeMemories(keep)).toEqual([
      {
        source: "observe",
        text: "hull scraped",
        tags: ["accumulate", "safety"],
        dims: { safety: 0.8, "burdened-exhilarated": -0.5 },
      },
    ])
  })

  it("observeMemories no longer synthesizes a one-hot from drive+weight", () => {
    const keep = {
      disposition: "accumulate" as const,
      emotionalWeight: "😟",
      drive: "safety",
      weight: 4,
      reason: "hull scraped",
    }
    // The tags still carry the fired drive (escalation-adjacent, untouched);
    // dims is now the model's vector, absent here — NOT { safety: 0.8 }.
    expect(observeMemories(keep)[0].tags).toEqual(["accumulate", "safety"])
    expect(observeMemories(keep)[0].dims).toEqual({})
  })

  it("observeMemories still drops a discarded event entirely", () => {
    const discard = {
      disposition: "discard" as const, emotionalWeight: "😐", drive: null, weight: 0, reason: "repeat",
    }
    expect(observeMemories(discard)).toEqual([])
  })

  it("orientMemories captures each section and whatChanged", () => {
    const orient = {
      headline: "h", whatChanged: "a new ship arrived", emotionalState: "😐", confidence: "high", metrics: {},
      sections: [{ id: "1", heading: "Threats", body: "raider nearby" }],
    } as OrientResult
    expect(orientMemories(orient)).toEqual([
      { source: "orient", text: "Threats: raider nearby", tags: ["high", "threats"], dims: {} },
      { source: "orient", text: "a new ship arrived", tags: ["high", "what-changed"], dims: {} },
    ])
  })

  it("decideMemories captures plan reasoning + steps, and nothing for non-plan decisions", () => {
    const plan = {
      decision: "plan", reasoning: "mine the belt",
      steps: [{ task: "fly", goal: "reach belt" }],
    } as unknown as DecideResult
    expect(decideMemories(plan)).toEqual([
      { source: "decide", text: "mine the belt", tags: ["plan", "reasoning"], dims: {} },
      { source: "decide", text: "fly: reach belt", tags: ["plan", "step"], dims: {} },
    ])
    expect(decideMemories({ decision: "continue", reasoning: "x" } as DecideResult)).toEqual([])
  })

  it("decideMemories handles a plan decision with no steps array without throwing", () => {
    const plan = { decision: "plan", reasoning: "mine the belt" } as unknown as DecideResult
    expect(decideMemories(plan)).toEqual([
      { source: "decide", text: "mine the belt", tags: ["plan", "reasoning"], dims: {} },
    ])
  })

  it("evaluateMemories captures judgment + reasoning", () => {
    const ev = { judgment: "failed", reasoning: "docking was rejected", transition: { transition: "replan", reason: "r" } } as EvaluateResult
    expect(evaluateMemories(ev)).toEqual([
      { source: "evaluate", text: "failed: docking was rejected", tags: ["failed"], dims: {} },
    ])
  })
})

describe("orientMemories carries the forebrain's axis vector", () => {
  const orient = {
    headline: "Fuel is thin",
    sections: [
      { id: "s1", heading: "Fuel", body: "Down to 6% and no depot in range." },
      { id: "s2", heading: "Company", body: "Two CULT pilots idling nearby." },
    ],
    whatChanged: "Fuel crossed into the low band.",
    emotionalState: "😟",
    confidence: "medium" as const,
    metrics: {},
    salience: { sustenance: 0.9, "burdened-exhilarated": -0.6 },
  }

  it("stamps the SAME vector on every memory the result produces", () => {
    const writes = orientMemories(orient)
    expect(writes).toHaveLength(3)
    for (const w of writes) {
      expect(w.dims).toEqual({ sustenance: 0.9, "burdened-exhilarated": -0.6 })
    }
  })

  it("leaves the section/whatChanged text and tags exactly as before", () => {
    const writes = orientMemories(orient)
    expect(writes[0].text).toBe("Fuel: Down to 6% and no depot in range.")
    expect(writes[0].tags).toEqual(["medium", "fuel"])
    expect(writes[2].text).toBe("Fuel crossed into the low band.")
    expect(writes[2].tags).toEqual(["medium", "what-changed"])
  })

  it("emits {} — not undefined — when the tier produced no vector", () => {
    const writes = orientMemories({ ...orient, salience: undefined })
    expect(writes[0].dims).toEqual({})
  })

  it("still drops a section with an empty body", () => {
    const writes = orientMemories({
      ...orient,
      sections: [{ id: "s1", heading: "Empty", body: "   " }],
      whatChanged: "",
    })
    expect(writes).toEqual([])
  })
})

describe("orientQuery", () => {
  it("returns empty string for no accumulated events, avoiding a wasted recall", () => {
    expect(orientQuery([], "😐")).toBe("")
  })
})

describe("formatRecall", () => {
  const NOW = Date.parse("2026-07-21T12:00:00Z")
  const mkHit = (over: Partial<MemoryHit>): MemoryHit => ({
    id: 1, ts: new Date(NOW).toISOString(), source: "orient",
    provenance: "inferred", tags: [], text: "x", score: 0.5, ...over,
  })
  it("returns empty string for no hits", () => {
    expect(formatRecall([], "You recall", NOW)).toBe("")
  })
  it("annotates each line with provenance and coarse age under the label", () => {
    const hits = [
      mkHit({ text: "docked at First Step", provenance: "grounded", ts: new Date(NOW - 2 * 60_000).toISOString() }),
      mkHit({ text: "readout may be unreliable", provenance: "inferred", ts: new Date(NOW - 5 * 3600_000).toISOString() }),
    ]
    const out = formatRecall(hits, "You recall", NOW)
    expect(out).toContain("## You recall")
    expect(out).toContain("- (grounded · ~2m ago) docked at First Step")
    expect(out).toContain("- (inferred · ~5h ago) readout may be unreliable")
  })
  it("still truncates to maxChars with an ellipsis", () => {
    expect(formatRecall([mkHit({ text: "A".repeat(50) })], "You recall", NOW, 20).length).toBeLessThanOrEqual(21)
  })
})

describe("formatAge", () => {
  it("buckets by minute/hour/day and flags unknown", () => {
    expect(formatAge(90_000)).toBe("~2m ago")
    expect(formatAge(5 * 3600_000)).toBe("~5h ago")
    expect(formatAge(3 * 24 * 3600_000)).toBe("~3d ago")
    expect(formatAge(NaN)).toBe("age unknown")
  })
})

describe("decideMemories / evaluateMemories carry the conscious tier's axis vector", () => {
  it("stamps the plan's vector on the reasoning AND every step memory", () => {
    const writes = decideMemories({
      decision: "plan",
      reasoning: "Refuel before the next jump.",
      steps: [
        { task: "dock", goal: "reach the depot" },
        { task: "buy fuel", goal: "top the tank" },
      ] as never,
      salience: { sustenance: 0.8, agency: 0.3 },
    })
    expect(writes).toHaveLength(3)
    for (const w of writes) expect(w.dims).toEqual({ sustenance: 0.8, agency: 0.3 })
    expect(writes[0].tags).toEqual(["plan", "reasoning"])
    expect(writes[1].tags).toEqual(["plan", "step"])
  })

  it("emits {} when the decide tier produced no vector", () => {
    const writes = decideMemories({
      decision: "plan", reasoning: "r", steps: [] as never,
    })
    expect(writes[0].dims).toEqual({})
  })

  it("still writes nothing for a non-plan decision", () => {
    expect(decideMemories({ decision: "continue", reasoning: "carry on", salience: { agency: 0.4 } })).toEqual([])
  })

  it("stamps the evaluate vector on the outcome lesson", () => {
    expect(
      evaluateMemories({
        judgment: "failed",
        reasoning: "The depot was dry.",
        transition: { transition: "replan", reason: "no fuel" },
        salience: { sustenance: 0.9, "burdened-exhilarated": -0.8 },
      }),
    ).toEqual([
      {
        source: "evaluate",
        text: "failed: The depot was dry.",
        tags: ["failed"],
        dims: { sustenance: 0.9, "burdened-exhilarated": -0.8 },
      },
    ])
  })

  it("evaluate emits {} with no vector, and still drops an empty reasoning", () => {
    expect(
      evaluateMemories({ judgment: "succeeded", reasoning: "done", transition: { transition: "next_step" } })[0].dims,
    ).toEqual({})
    expect(
      evaluateMemories({ judgment: "succeeded", reasoning: "  ", transition: { transition: "next_step" } }),
    ).toEqual([])
  })
})

describe("MemoryGateway", () => {
  it("remember dedups identical normalized text within a (container,char)", async () => {
    const store = fakeStore()
    await run(store, Effect.gen(function* () {
      const g = yield* MemoryGateway
      yield* g.remember("cid", char, { source: "orient", text: "The Belt Is Rich", tags: [] })
      yield* g.remember("cid", char, { source: "orient", text: "  the belt is rich  ", tags: [] }) // dup
      yield* g.remember("cid", char, { source: "orient", text: "different", tags: [] })
    }))
    expect(store.remembered.map((r) => r.text)).toEqual(["The Belt Is Rich", "different"])
  })

  it("remember never throws when the store fails", async () => {
    const store = fakeStore({ fail: true })
    await run(store, Effect.gen(function* () {
      const g = yield* MemoryGateway
      yield* g.remember("cid", char, { source: "orient", text: "x", tags: [] })
    }))
    expect(store.remembered).toEqual([])
  })

  it("recall returns a formatted block, and empty string when the store fails", async () => {
    const ok = fakeStore({ hits: [{ id: 1, ts: "2026-07-21T12:00:00Z", source: "orient", provenance: "inferred", tags: [], text: "remembered fact", score: 1 }] as MemoryHit[] })
    const okBlock = await run(ok, Effect.flatMap(MemoryGateway, (g) => g.recall("cid", char, "q", { k: 5, label: "Relevant memories" })))
    expect(okBlock).toContain("## Relevant memories")
    expect(okBlock).toContain("remembered fact")

    const bad = fakeStore({ fail: true })
    const badBlock = await run(bad, Effect.flatMap(MemoryGateway, (g) => g.recall("cid", char, "q", { k: 5, label: "Relevant memories" })))
    expect(badBlock).toBe("")
  })

  it("recall over-fetches the store by RERANK_OVERFETCH before reranking down to k", async () => {
    const store = fakeStore()
    await run(store, Effect.flatMap(MemoryGateway, (g) => g.recall("cid", char, "q", { k: 3, label: "Relevant memories" })))
    expect(store.recalledKs).toEqual([3 * RERANK_OVERFETCH])
  })

  it("ranks with the character's emotional state read from me/mood.json", async () => {
    // The mood-matching hit is deliberately LESS relevant (0.5 vs 0.6), so it can
    // only reach the top through the situational factor. Do NOT make the two hits
    // identical and rely on a tie: they would not actually tie — their salience
    // weights differ (0.5 vs NEUTRAL_SALIENCE), so their half-lives differ, and at
    // a few milliseconds of age that already separates them by ~1e-9 in the
    // dominant memory's favour. The margin here is 0.15, well clear of that dust.
    //
    //   HIGHREL   : 0.6 × grounded 1.0 × ~1 × 1.0 = 0.60
    //   MOODMATCH : 0.5 × grounded 1.0 × ~1 × 1.5 = 0.75
    //
    // Deleting the readMood line drops the factor to 1.0 and HIGHREL wins.
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "roci-gw-mood-"))
    const moodChar = { name: "ada", root: path.join(tmpRoot, "ada") } as CharacterConfig
    mkdirSync(path.join(moodChar.root, "me"), { recursive: true })
    writeFileSync(
      path.join(moodChar.root, "me", "mood.json"),
      JSON.stringify({ version: 1, updatedAt: "2026-08-01T00:00:00.000Z", state: { safety: 1 } }),
    )
    const ts = new Date().toISOString()
    const store = fakeStore({
      hits: [
        { id: 1, ts, source: "orient", provenance: "grounded", tags: [], text: "HIGHREL", score: 0.6, dims: {} },
        { id: 2, ts, source: "orient", provenance: "grounded", tags: [], text: "MOODMATCH", score: 0.5, dims: { safety: 1 } },
      ] as MemoryHit[],
    })
    const block = await run(
      store,
      Effect.flatMap(MemoryGateway, (g) =>
        g.recall("cid", moodChar, "q", { k: 2, label: "Relevant memories" }),
      ),
    )
    expect(block.indexOf("MOODMATCH")).toBeGreaterThan(-1)
    expect(block.indexOf("HIGHREL")).toBeGreaterThan(-1)
    expect(block.indexOf("MOODMATCH")).toBeLessThan(block.indexOf("HIGHREL"))
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it("degrades to an inert situational factor when there is no mood file", async () => {
    // Every other test in this file uses a character whose root holds no
    // mood.json, so this is also the assertion that they keep passing: no mood →
    // factor 1 → ranking is exactly what it was before the situational term existed.
    const ts = new Date().toISOString()
    const store = fakeStore({
      hits: [
        { id: 1, ts, source: "orient", provenance: "asserted", tags: [], text: "LOWTRUST", score: 0.5, dims: { safety: 1 } },
        { id: 2, ts, source: "orient", provenance: "grounded", tags: [], text: "HIGHTRUST", score: 0.5, dims: {} },
      ] as MemoryHit[],
    })
    const block = await run(
      store,
      Effect.flatMap(MemoryGateway, (g) => g.recall("cid", char, "q", { k: 2, label: "Relevant memories" })),
    )
    expect(block.indexOf("HIGHTRUST")).toBeLessThan(block.indexOf("LOWTRUST"))
  })
})

describe("recall telemetry", () => {
  const poolHits = (n: number): MemoryHit[] =>
    Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      ts: new Date().toISOString(),
      source: "orient",
      provenance: "grounded" as const,
      tags: [],
      text: `hit-${i + 1}`,
      score: 1 - i / 100,
      dims: {},
      stage: "base" as const,
    }))

  it("emits one record carrying the WHOLE scored pool, k of it flagged returned", async () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "roci-gw-tel-"))
    const telChar = { name: "ada", root: path.join(tmpRoot, "ada") } as CharacterConfig
    const store = fakeStore({ hits: poolHits(7) })
    const block = await run(
      store,
      Effect.flatMap(MemoryGateway, (g) =>
        g.recall("cid", telChar, "why did the hull scrape", { k: 3, label: "Relevant memories" }),
      ),
    )
    const lines = readFileSync(
      path.join(telChar.root, "logs", RECALL_TELEMETRY_FILE),
      "utf8",
    ).trim().split("\n")
    expect(lines).toHaveLength(1)
    const rec = JSON.parse(lines[0]) as RecallTelemetryRecord

    // The losers survive: every scored candidate is present, not just the top k.
    expect(rec.poolSize).toBe(7)
    expect(rec.candidates).toHaveLength(7)
    expect(rec.returnedCount).toBe(3)
    expect(rec.candidates.filter((c) => c.returned)).toHaveLength(3)
    // …and exactly the ones that reached the prompt.
    for (const c of rec.candidates) {
      expect(block.includes(`hit-${c.id}`)).toBe(c.returned)
    }
    // The pool is NOT the character's memories — the record must say so itself.
    expect(rec.poolTruncatedUpstream).toBe(true)
    expect(rec.fetchLimit).toBe(3 * RERANK_OVERFETCH)
    // Every factor recorded, and the product is the score that was sorted on.
    const top = rec.candidates[0]
    expect(top.score.rel * top.score.rep * top.score.rec * top.score.sit)
      .toBeCloseTo(top.score.composite, 12)
    // Mood diagnostics: distinguishable "no mood" rather than an absent field.
    expect(rec.mood).toMatchObject({ norm: 0, nonZeroAxes: 0, empty: true })
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it("stamps WHICH scoring world produced the numbers, and marks its absences as absences", async () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "roci-gw-ctx-"))
    const telChar = { name: "ada", root: path.join(tmpRoot, "ada") } as CharacterConfig
    // Exactly what buildRunnerConfig publishes at the ONE derivation site.
    publishAxisVocabulary("ada", [
      { name: "safety", polarity: "unipolar", positiveGloss: "safety: staying intact", negativeGloss: "" },
      { name: "grumbling-tender", polarity: "bipolar", positiveGloss: "tender", negativeGloss: "grumbling" },
    ])
    try {
      await run(
        fakeStore({ hits: poolHits(4) }),
        Effect.flatMap(MemoryGateway, (g) =>
          g.recall("cid", telChar, "q", { k: 2, label: "Relevant memories" }),
        ),
      )
      const rec = JSON.parse(
        readFileSync(path.join(telChar.root, "logs", RECALL_TELEMETRY_FILE), "utf8").trim(),
      ) as RecallTelemetryRecord
      const ctx = rec.scoringContext
      expect(ctx.axisNames).toEqual(["safety", "grumbling-tender"])
      expect(ctx.axisVocabHash).toMatch(/^[0-9a-f]{16}$/)
      expect(ctx.axisGlossHash).toMatch(/^[0-9a-f]{16}$/)
      expect(ctx.axisSource).toBe("runner-config")
      expect(ctx.glossAvailability).toBe("host-resolved")
      expect(ctx.constants.RERANK_OVERFETCH).toBe(RERANK_OVERFETCH)
      expect(ctx.scorerVersion).toBe(SCORER_VERSION)
      // No launcher published a model here, so the record says so rather than guessing.
      expect(ctx.embedder).toMatchObject({ model: null, modelSource: "unknown" })
    } finally {
      clearAxisVocabulary()
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it("injection is off by default under vitest, and swaps a REJECTED candidate into the prompt when forced on", async () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "roci-gw-inj-"))
    const offChar = { name: "ada", root: path.join(tmpRoot, "off") } as CharacterConfig
    const onChar = { name: "ada", root: path.join(tmpRoot, "on") } as CharacterConfig
    const readRec = (c: CharacterConfig): RecallTelemetryRecord =>
      JSON.parse(readFileSync(path.join(c.root, "logs", RECALL_TELEMETRY_FILE), "utf8").trim())

    await run(
      fakeStore({ hits: poolHits(8) }),
      Effect.flatMap(MemoryGateway, (g) =>
        g.recall("cid", offChar, "q", { k: 2, label: "Relevant memories" }),
      ),
    )
    const off = readRec(offChar)
    expect(off.injection).toMatchObject({ enabled: false, rate: 0, fired: false })
    expect(off.candidates.every((c) => c.injection === "ranked")).toBe(true)

    process.env.ROCI_RECALL_INJECTION_RATE = "1"
    process.env.ROCI_RECALL_INJECTION_SEED = "gateway-test"
    let block: string
    try {
      block = await run(
        fakeStore({ hits: poolHits(8) }),
        Effect.flatMap(MemoryGateway, (g) =>
          g.recall("cid", onChar, "q", { k: 2, label: "Relevant memories" }),
        ),
      )
    } finally {
      delete process.env.ROCI_RECALL_INJECTION_RATE
      delete process.env.ROCI_RECALL_INJECTION_SEED
    }
    const on = readRec(onChar)
    expect(on.injection).toMatchObject({ enabled: true, rate: 1, fired: true, seed: "gateway-test" })
    // The injected candidate came from OUTSIDE the ranker's top k…
    expect(on.injection.injectedRank as number).toBeGreaterThan(2)
    // …and it is the one, and only one, flagged random.
    const random = on.candidates.filter((c) => c.injection === "random")
    expect(random).toHaveLength(1)
    expect(random[0].id).toBe(on.injection.injectedId)
    // The prompt reflects the swap: injected in, displaced out, count unchanged.
    expect(on.returnedCount).toBe(2)
    expect(block).toContain(`hit-${on.injection.injectedId}`)
    expect(block).not.toContain(`hit-${on.injection.displacedId}`)
    // …and the displaced one is still recognisable: top-k rank, but not returned.
    const displaced = on.candidates.find((c) => c.id === on.injection.displacedId)
    expect(displaced).toMatchObject({ rank: 2, returned: false, injection: "ranked" })
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it("declares its own partial coverage on every record", async () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "roci-gw-cov-"))
    const c = { name: "ada", root: path.join(tmpRoot, "ada") } as CharacterConfig
    await run(
      fakeStore({ hits: poolHits(2) }),
      Effect.flatMap(MemoryGateway, (g) =>
        g.recall("cid", c, "q", { k: 1, label: "Relevant memories", site: "decide" }),
      ),
    )
    const rec = JSON.parse(
      readFileSync(path.join(c.root, "logs", RECALL_TELEMETRY_FILE), "utf8").trim(),
    ) as RecallTelemetryRecord
    expect(rec.coverage.site).toBe("decide")
    // macro.ts calls LongtermStore.recall directly and the agent can search in
    // the container: three of five known paths reach this stream, and the record
    // NAMES the two that do not rather than leaving the gap silent.
    expect(rec.coverage.uncovered).toEqual(["macro-synthesis", "agent-container-search"])
    expect(rec.coverage.knownSites).toBe(RECALL_SITES.length)
    expect(rec.coverage.coveredSites).toBe(3)
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it("the usage record joins its recall record by recallId, and scores the injected control like any other candidate", async () => {
    resetPendingRecalls()
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "roci-gw-usage-"))
    const c = { name: "ada", root: path.join(tmpRoot, "ada") } as CharacterConfig
    // Real prose, so textual overlap means something.
    const texts = [
      "The jump to Horizon failed because the drive coil overheated at 3.5 AU.",
      "Pilots from Famine and Pedro Vaz were docked at Altais when I arrived.",
      "The broker at Altais pays 41 credits per unit of raw iridium ore.",
      "A scan of the Horizon gate returned coordinates 3.5 and minus 0.8.",
      "Refuelling costs twice as much at Famine as it does at Altais.",
      "The cargo bay seal has been leaking since the second mining run.",
    ]
    const hits: MemoryHit[] = texts.map((text, i) => ({
      id: 100 + i,
      ts: new Date().toISOString(),
      source: "orient",
      provenance: "grounded" as const,
      tags: [],
      text,
      score: 1 - i / 100,
      dims: {},
      stage: "base" as const,
    }))

    process.env.ROCI_RECALL_INJECTION_RATE = "1"
    process.env.ROCI_RECALL_INJECTION_SEED = "usage-join-test"
    let recallId: string | null
    try {
      recallId = await run(
        fakeStore({ hits }),
        Effect.flatMap(MemoryGateway, (g) =>
          g
            .recallWithId("cid", c, "why did the jump fail", {
              k: 2,
              label: "Relevant memories",
              site: "decide",
            })
            .pipe(Effect.map((r) => r.recallId)),
        ),
      )
    } finally {
      delete process.env.ROCI_RECALL_INJECTION_RATE
      delete process.env.ROCI_RECALL_INJECTION_SEED
    }
    const recall = JSON.parse(
      readFileSync(path.join(c.root, "logs", RECALL_TELEMETRY_FILE), "utf8").trim(),
    ) as RecallTelemetryRecord
    expect(recallId).toBe(recall.recallId)
    expect(recall.injection.fired).toBe(true)

    // The agent's output for the step quotes the INJECTED (control) memory
    // verbatim and never mentions the ranked winners.
    const injected = recall.candidates.find((x) => x.id === recall.injection.injectedId)
    if (!injected) throw new Error("no injected candidate")
    const injectedText = texts[injected.id - 100]
    await Effect.runPromise(
      recordRecallUsage(c, recallId, {
        outputKind: "decide",
        output: `Replanning. ${injectedText} I will vent heat before re-attempting.`,
      }),
    )

    const usage = JSON.parse(
      readFileSync(path.join(c.root, "logs", RECALL_USAGE_FILE), "utf8").trim(),
    ) as RecallUsageRecord
    // THE JOIN: same id, and the usage candidates are exactly the recall
    // record's returned set.
    expect(usage.recallId).toBe(recall.recallId)
    expect(usage.site).toBe("decide")
    expect(usage.candidates.map((x) => x.memoryId).sort()).toEqual(
      recall.candidates.filter((x) => x.returned).map((x) => x.id).sort(),
    )
    // The control arm is scored, not skipped — excluding it would destroy it.
    const control = usage.candidates.find((x) => x.injection === "random")
    if (!control) throw new Error("injected candidate missing from usage record")
    expect(control.memoryId).toBe(recall.injection.injectedId)
    expect(control.contentContainment).toBe(1)
    expect(control.longestMatchedNgram).toBe(8)
    // …and the ranked candidate the agent did not quote scores near zero, so the
    // signal discriminates rather than firing on everything.
    const ranked = usage.candidates.filter((x) => x.injection === "ranked")
    expect(ranked.length).toBeGreaterThan(0)
    for (const r of ranked) expect(r.contentContainment as number).toBeLessThan(0.5)
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it("a telemetry write failure cannot break a recall", async () => {
    // Root whose parent is a FILE: mkdir(logsDir) fails with ENOTDIR.
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "roci-gw-tel-fail-"))
    writeFileSync(path.join(tmpRoot, "blocked"), "not a directory")
    const brokenChar = { name: "ada", root: path.join(tmpRoot, "blocked", "ada") } as CharacterConfig
    const store = fakeStore({ hits: poolHits(2) })
    const block = await run(
      store,
      Effect.flatMap(MemoryGateway, (g) =>
        g.recall("cid", brokenChar, "q", { k: 1, label: "Relevant memories" }),
      ),
    )
    expect(block).toContain("hit-1")
    rmSync(tmpRoot, { recursive: true, force: true })
  })
})
