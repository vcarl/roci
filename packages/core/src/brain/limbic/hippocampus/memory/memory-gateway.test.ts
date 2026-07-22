import { Effect, Layer } from "effect"
import { describe, it, expect } from "vitest"
import { LongtermStore, type MemoryHit } from "./longterm-store.js"
import type { CharacterConfig } from "../../../../services/CharacterFs.js"
import type { ObserveResult, OrientResult, DecideResult, EvaluateResult } from "../../../../skills/types.js"
import { RERANK_OVERFETCH } from "./memory-rank.js"
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

const char = { name: "ada" } as CharacterConfig

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
    }),
  )
  return { layer, remembered, recalledKs }
}

const run = <A>(store: ReturnType<typeof fakeStore>, program: Effect.Effect<A, never, MemoryGateway>) =>
  Effect.runPromise(program.pipe(Effect.provide(MemoryGatewayLive.pipe(Layer.provide(store.layer)))))

describe("pure capture extractors", () => {
  it("observeMemories drops discards and captures the reason with disposition + drive tags", () => {
    const discard = { disposition: "discard", emotionalWeight: "😐", drive: "curiosity", weight: 0, reason: "noise" } as ObserveResult
    const keep = { disposition: "escalate", emotionalWeight: "😨", drive: "safety", weight: 9, reason: "hull breach imminent" } as ObserveResult
    expect(observeMemories(discard)).toEqual([])
    expect(observeMemories(keep)).toEqual([
      { source: "observe", text: "hull breach imminent", tags: ["escalate", "safety"] },
    ])
  })

  it("orientMemories captures each section and whatChanged", () => {
    const orient = {
      headline: "h", whatChanged: "a new ship arrived", emotionalState: "😐", confidence: "high", metrics: {},
      sections: [{ id: "1", heading: "Threats", body: "raider nearby" }],
    } as OrientResult
    expect(orientMemories(orient)).toEqual([
      { source: "orient", text: "Threats: raider nearby", tags: ["high", "threats"] },
      { source: "orient", text: "a new ship arrived", tags: ["high", "what-changed"] },
    ])
  })

  it("decideMemories captures plan reasoning + steps, and nothing for non-plan decisions", () => {
    const plan = {
      decision: "plan", reasoning: "mine the belt",
      steps: [{ task: "fly", goal: "reach belt" }],
    } as unknown as DecideResult
    expect(decideMemories(plan)).toEqual([
      { source: "decide", text: "mine the belt", tags: ["plan", "reasoning"] },
      { source: "decide", text: "fly: reach belt", tags: ["plan", "step"] },
    ])
    expect(decideMemories({ decision: "continue", reasoning: "x" } as DecideResult)).toEqual([])
  })

  it("decideMemories handles a plan decision with no steps array without throwing", () => {
    const plan = { decision: "plan", reasoning: "mine the belt" } as unknown as DecideResult
    expect(decideMemories(plan)).toEqual([
      { source: "decide", text: "mine the belt", tags: ["plan", "reasoning"] },
    ])
  })

  it("evaluateMemories captures judgment + reasoning", () => {
    const ev = { judgment: "failed", reasoning: "docking was rejected", transition: { transition: "replan", reason: "r" } } as EvaluateResult
    expect(evaluateMemories(ev)).toEqual([
      { source: "evaluate", text: "failed: docking was rejected", tags: ["failed"] },
    ])
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
})
