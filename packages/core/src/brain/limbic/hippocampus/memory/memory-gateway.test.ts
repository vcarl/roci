import { Effect, Layer } from "effect"
import { describe, it, expect } from "vitest"
import { LongtermStore, type MemoryHit } from "./longterm-store.js"
import type { CharacterConfig } from "../../../../services/CharacterFs.js"
import type { ObserveResult, OrientResult, DecideResult, EvaluateResult } from "../../../../skills/types.js"
import {
  observeMemories,
  orientMemories,
  decideMemories,
  evaluateMemories,
  formatRecall,
  orientQuery,
  MemoryGateway,
  MemoryGatewayLive,
} from "./memory-gateway.js"

const char = { name: "ada" } as CharacterConfig

function fakeStore(opts: { hits?: MemoryHit[]; fail?: boolean } = {}) {
  const remembered: Array<{ text: string; source: string; tags: ReadonlyArray<string> }> = []
  const layer = Layer.succeed(
    LongtermStore,
    LongtermStore.of({
      readMark: () => Effect.succeed(null),
      writeMark: () => Effect.void,
      promote: () => Effect.succeed(0),
      remember: (_id, _char, entry) =>
        opts.fail ? Effect.fail(new Error("boom")) : Effect.sync(() => void remembered.push(entry)),
      recall: (_id, _char, _q, _o) =>
        opts.fail ? Effect.fail(new Error("boom")) : Effect.succeed(opts.hits ?? []),
    }),
  )
  return { layer, remembered }
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
  it("returns empty string for no hits", () => {
    expect(formatRecall([], "You recall")).toBe("")
  })
  it("renders a labeled block and truncates to maxChars", () => {
    const hits = [{ id: 1, ts: "t", source: "orient", tags: [], text: "AAAAAAAAAA", score: 1 }] as MemoryHit[]
    expect(formatRecall(hits, "You recall")).toContain("## You recall")
    expect(formatRecall(hits, "You recall")).toContain("- AAAAAAAAAA")
    expect(formatRecall(hits, "You recall", 10).length).toBeLessThanOrEqual(11) // 10 + ellipsis
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
    const ok = fakeStore({ hits: [{ id: 1, ts: "t", source: "orient", tags: [], text: "remembered fact", score: 1 }] as MemoryHit[] })
    const okBlock = await run(ok, Effect.flatMap(MemoryGateway, (g) => g.recall("cid", char, "q", { k: 5, label: "Relevant memories" })))
    expect(okBlock).toContain("## Relevant memories")
    expect(okBlock).toContain("- remembered fact")

    const bad = fakeStore({ fail: true })
    const badBlock = await run(bad, Effect.flatMap(MemoryGateway, (g) => g.recall("cid", char, "q", { k: 5, label: "Relevant memories" })))
    expect(badBlock).toBe("")
  })
})
