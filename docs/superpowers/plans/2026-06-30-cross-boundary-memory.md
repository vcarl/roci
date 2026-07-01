# Cross-boundary Memory Capture + Auto-recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliberately capture the structured facts that already cross cortex phase boundaries into long-term memory, and automatically inject relevant recalled memories back into the orient/decide/evaluate prompts.

**Architecture:** A new `MemoryGateway` Effect service owns all memory *policy* (typing, tagging, dedup, recall query-building, prompt formatting) layered on top of `LongtermStore`, which gains two new *shelling* Effects (`remember`, `recall`) over the existing in-container `memory` CLI. Pure extractor functions turn each phase's boundary payload into `MemoryWrite[]`; the cortex loop calls `gateway.remember(...)` per write at each boundary and `gateway.recall(...)` just before each memory-aware phase.

**Tech Stack:** TypeScript, Effect (`Context.Tag`, `Layer`, `Effect.gen`), vitest, pnpm + nx, sqlite-vec via an in-container bun `memory` CLI shelled over `docker exec`.

## Global Constraints

- Package manager is **pnpm** (`pnpm@9.15.9`); test runner is **vitest**. Single file: `pnpm vitest --run <path>`. Whole suite: `pnpm test`. Typecheck: `pnpm typecheck`. Build: `pnpm build`.
- Cross-package imports (from `apps/roci`) use the `@roci/core/*` export map with `.js` extensions (e.g. `@roci/core/conscious/memory-gateway.js`); imports *within* `packages/core` are relative with `.js` extensions (e.g. `./longterm-store.js`).
- All memory writes/reads are **best-effort**: a failure must never crash or block the cortex loop. `LongtermStore.remember`/`recall` may fail with `Error`; `MemoryGateway.remember`/`recall` swallow failures (`Effect<…, never>`).
- The in-container `memory remember` CLI **already accepts `--source` and `--tags`** (`packages/core/src/conscious/memory-cli.ts:145-157`) and `memory search` already emits NDJSON `{id, ts, source, tags[], text, score}` (`:158-174`, `fmt` at `:118-124`). Do **not** modify the CLI generator.
- Shell strings are single-quoted via the existing `shQuote` helper in `longterm-store.ts`.
- The hindbrain volume decision is **capture all non-`discard` observe reasons** (per the approved spec). Do not add a salience gate.

---

### Task 1: Add `remember` + `recall` to `LongtermStore`

**Files:**
- Modify: `packages/core/src/conscious/longterm-store.ts` (add `MemoryHit` type, two Tag methods, two Live implementations)
- Test: `packages/core/src/conscious/longterm-store.test.ts` (add a describe block)
- Modify: `packages/core/src/core/orchestrator/planned-action.test.ts:62-80` (extend the fake double so it still satisfies the Tag)

**Interfaces:**
- Consumes: existing `shQuote`, `playerCwd`/`cd`, `MEMORY_CLI_PATH`, `Docker` in this file.
- Produces:
  - `export interface MemoryHit { readonly id: number; readonly ts: string; readonly source: string; readonly tags: ReadonlyArray<string>; readonly text: string; readonly score: number }`
  - `LongtermStore.remember(containerId: string, char: CharacterConfig, entry: { text: string; source: string; tags: ReadonlyArray<string> }): Effect.Effect<void, Error>`
  - `LongtermStore.recall(containerId: string, char: CharacterConfig, query: string, opts?: { k?: number; tags?: ReadonlyArray<string> }): Effect.Effect<ReadonlyArray<MemoryHit>, Error>`

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/conscious/longterm-store.test.ts`. This is self-contained (own `Docker` stub); if the file already has a shared stub harness, prefer reusing it, but this stands alone:

```typescript
import { Effect, Layer } from "effect"
import { describe, it, expect } from "vitest"
import { Docker } from "../services/Docker.js"
import { LongtermStore, LongtermStoreLive, MEMORY_CLI_PATH, type MemoryHit } from "./longterm-store.js"
import type { CharacterConfig } from "../services/CharacterFs.js"

const char = { name: "ada space" } as CharacterConfig

// Minimal Docker stub: records the argv it was called with, returns canned stdout.
function dockerStub(stdout: string, captured: string[][]) {
  return Layer.succeed(Docker, {
    exec: (_id: string, args: ReadonlyArray<string>) =>
      Effect.sync(() => {
        captured.push([...args])
        return stdout
      }),
  } as unknown as Parameters<typeof Layer.succeed<typeof Docker>>[1])
}

describe("LongtermStore.remember / recall", () => {
  it("remember shells `memory remember` with quoted text, --tags and --source", async () => {
    const captured: string[][] = []
    await Effect.runPromise(
      Effect.flatMap(LongtermStore, (s) =>
        s.remember("cid", char, { text: "the wormhole is unstable", source: "orient", tags: ["medium", "situation"] }),
      ).pipe(Effect.provide(LongtermStoreLive.pipe(Layer.provide(dockerStub("", captured))))),
    )
    const joined = captured.flat().join(" ")
    expect(joined).toContain(`cd '/work/players/ada space'`)
    expect(joined).toContain(`${MEMORY_CLI_PATH} remember 'the wormhole is unstable'`)
    expect(joined).toContain(`--tags 'medium,situation'`)
    expect(joined).toContain(`--source 'orient'`)
  })

  it("recall shells `memory search` with -k and parses NDJSON into hits", async () => {
    const captured: string[][] = []
    const ndjson =
      `{"id":1,"ts":"t","source":"orient","tags":["a"],"text":"first","score":0.9}\n` +
      `{"id":2,"ts":"t","source":"evaluate","tags":[],"text":"second","score":0.5}\n` +
      `   \n` // blank line must be ignored
    const hits: ReadonlyArray<MemoryHit> = await Effect.runPromise(
      Effect.flatMap(LongtermStore, (s) => s.recall("cid", char, "danger", { k: 2 })).pipe(
        Effect.provide(LongtermStoreLive.pipe(Layer.provide(dockerStub(ndjson, captured)))),
      ),
    )
    const joined = captured.flat().join(" ")
    expect(joined).toContain(`${MEMORY_CLI_PATH} search 'danger' -k 2`)
    expect(hits.map((h) => h.text)).toEqual(["first", "second"])
    expect(hits[0].score).toBeCloseTo(0.9)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest --run packages/core/src/conscious/longterm-store.test.ts`
Expected: FAIL — `s.remember is not a function` / `s.recall is not a function` (and a type error that `remember`/`recall`/`MemoryHit` don't exist).

- [ ] **Step 3: Add the `MemoryHit` type and the two Tag methods**

In `packages/core/src/conscious/longterm-store.ts`, add the type just above the `LongtermStore` class:

```typescript
/** A ranked recall hit — one NDJSON line from the in-container `memory search`. */
export interface MemoryHit {
  readonly id: number
  readonly ts: string
  readonly source: string
  readonly tags: ReadonlyArray<string>
  readonly text: string
  readonly score: number
}
```

Then inside the `LongtermStore` Tag's method object (after `promote`), add:

```typescript
    /** Persist a single memory with an explicit source + tags (in-container `memory remember`). */
    readonly remember: (
      containerId: string,
      char: CharacterConfig,
      entry: { readonly text: string; readonly source: string; readonly tags: ReadonlyArray<string> },
    ) => Effect.Effect<void, Error>
    /** Semantic recall of top-k memories (in-container `memory search`); parses NDJSON. */
    readonly recall: (
      containerId: string,
      char: CharacterConfig,
      query: string,
      opts?: { readonly k?: number; readonly tags?: ReadonlyArray<string> },
    ) => Effect.Effect<ReadonlyArray<MemoryHit>, Error>
```

- [ ] **Step 4: Implement the two methods in `LongtermStoreLive`**

In the `LongtermStore.of({ ... })` object in `LongtermStoreLive` (after the `promote` implementation), add:

```typescript
      remember: (containerId, char, entry) => {
        const tagsArg = entry.tags.length > 0 ? ` --tags ${shQuote(entry.tags.join(","))}` : ""
        const cmd =
          `${cd(char)} && ${MEMORY_CLI_PATH} remember ${shQuote(entry.text)}` +
          `${tagsArg} --source ${shQuote(entry.source)}`
        return docker.exec(containerId, ["bash", "-lc", cmd]).pipe(Effect.mapError(fail), Effect.asVoid)
      },
      recall: (containerId, char, query, opts) =>
        Effect.gen(function* () {
          const k = opts?.k ?? 5
          const tagsArg = opts?.tags && opts.tags.length > 0 ? ` --tags ${shQuote(opts.tags.join(","))}` : ""
          const cmd = `${cd(char)} && ${MEMORY_CLI_PATH} search ${shQuote(query)} -k ${k}${tagsArg}`
          const out = yield* docker.exec(containerId, ["bash", "-lc", cmd]).pipe(Effect.mapError(fail))
          return out
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0)
            .flatMap((l) => {
              try {
                return [JSON.parse(l) as MemoryHit]
              } catch {
                return []
              }
            })
        }),
```

- [ ] **Step 5: Extend the fake double so the other test suite still compiles**

In `packages/core/src/core/orchestrator/planned-action.test.ts`, inside `makeStore()`'s `LongtermStore.of({ ... })` (after `promote`), add:

```typescript
      remember: () => Effect.void,
      recall: () => Effect.succeed([]),
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest --run packages/core/src/conscious/longterm-store.test.ts packages/core/src/core/orchestrator/planned-action.test.ts`
Expected: PASS (both files).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/conscious/longterm-store.ts packages/core/src/conscious/longterm-store.test.ts packages/core/src/core/orchestrator/planned-action.test.ts
git commit -m "feat(memory): add remember + recall shelling Effects to LongtermStore"
```

---

### Task 2: `MemoryGateway` service + pure capture/query/format helpers

**Files:**
- Create: `packages/core/src/conscious/memory-gateway.ts`
- Test: `packages/core/src/conscious/memory-gateway.test.ts`

**Interfaces:**
- Consumes: `LongtermStore` + `MemoryHit` (Task 1); `ObserveResult`, `OrientResult`, `DecideResult`, `EvaluateResult` from `../skills/types.js`.
- Produces:
  - `export interface MemoryWrite { readonly source: string; readonly text: string; readonly tags: ReadonlyArray<string> }`
  - Pure: `observeMemories(observe: ObserveResult): MemoryWrite[]`, `orientMemories(orient: OrientResult): MemoryWrite[]`, `decideMemories(decide: DecideResult): MemoryWrite[]`, `evaluateMemories(evalResult: EvaluateResult): MemoryWrite[]`
  - Pure: `orientQuery(accumulatedEvents: ReadonlyArray<string>, emotionalWeight: string): string`, `decideQuery(orient: OrientResult): string`, `evaluateQuery(task: string, goal: string): string`
  - Pure: `formatRecall(hits: ReadonlyArray<MemoryHit>, label: string, maxChars?: number): string`
  - `MemoryGateway` Tag with `remember(containerId, char, write: MemoryWrite): Effect<void, never>` and `recall(containerId, char, query, opts: { k: number; label: string; maxChars?: number; tags?: ReadonlyArray<string> }): Effect<string, never>`
  - `MemoryGatewayLive: Layer.Layer<MemoryGateway, never, LongtermStore>`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/conscious/memory-gateway.test.ts`:

```typescript
import { Effect, Layer } from "effect"
import { describe, it, expect } from "vitest"
import { LongtermStore, type MemoryHit } from "./longterm-store.js"
import type { CharacterConfig } from "../services/CharacterFs.js"
import type { ObserveResult, OrientResult, DecideResult, EvaluateResult } from "../skills/types.js"
import {
  observeMemories,
  orientMemories,
  decideMemories,
  evaluateMemories,
  formatRecall,
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
    } as DecideResult
    expect(decideMemories(plan)).toEqual([
      { source: "decide", text: "mine the belt", tags: ["plan", "reasoning"] },
      { source: "decide", text: "fly: reach belt", tags: ["plan", "step"] },
    ])
    expect(decideMemories({ decision: "continue", reasoning: "x" } as DecideResult)).toEqual([])
  })

  it("evaluateMemories captures judgment + reasoning", () => {
    const ev = { judgment: "failed", reasoning: "docking was rejected", transition: { transition: "replan", reason: "r" } } as EvaluateResult
    expect(evaluateMemories(ev)).toEqual([
      { source: "evaluate", text: "failed: docking was rejected", tags: ["failed"] },
    ])
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest --run packages/core/src/conscious/memory-gateway.test.ts`
Expected: FAIL — cannot resolve `./memory-gateway.js` (module does not exist yet).

- [ ] **Step 3: Create the module**

Create `packages/core/src/conscious/memory-gateway.ts`:

```typescript
import { Context, Effect, Layer } from "effect"
import type { CharacterConfig } from "../services/CharacterFs.js"
import { LongtermStore, type MemoryHit } from "./longterm-store.js"
import type { ObserveResult, OrientResult, DecideResult, EvaluateResult } from "../skills/types.js"

/** One unit to persist: the source phase, the text, and derived tags. */
export interface MemoryWrite {
  readonly source: string
  readonly text: string
  readonly tags: ReadonlyArray<string>
}

const clip = (s: string, n = 500): string => (s.length <= n ? s : s.slice(0, n))
const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)

// ---- Pure capture extractors: what a boundary payload contributes to memory ----

/** Hindbrain observe → memory: the appraisal reason, unless discarded/empty. */
export function observeMemories(observe: ObserveResult): MemoryWrite[] {
  if (observe.disposition === "discard") return []
  const reason = observe.reason?.trim()
  if (!reason) return []
  const tags = [observe.disposition, ...(observe.drive ? [observe.drive] : [])]
  return [{ source: "observe", text: clip(reason), tags }]
}

/** Orient → memory: each section (heading + body) plus whatChanged. */
export function orientMemories(orient: OrientResult): MemoryWrite[] {
  const out: MemoryWrite[] = []
  const sections = Array.isArray(orient.sections) ? orient.sections : []
  for (const s of sections) {
    const body = s.body?.trim()
    if (!body) continue
    out.push({ source: "orient", text: clip(`${s.heading}: ${body}`), tags: [orient.confidence, slug(s.heading)].filter(Boolean) })
  }
  const changed = orient.whatChanged?.trim()
  if (changed) out.push({ source: "orient", text: clip(changed), tags: [orient.confidence, "what-changed"] })
  return out
}

/** Decide → memory: plan reasoning + each step's intent (plan decisions only). */
export function decideMemories(decide: DecideResult): MemoryWrite[] {
  if (decide.decision !== "plan") return []
  const out: MemoryWrite[] = []
  const reasoning = decide.reasoning?.trim()
  if (reasoning) out.push({ source: "decide", text: clip(reasoning), tags: ["plan", "reasoning"] })
  for (const step of decide.steps) {
    const t = `${step.task}: ${step.goal}`.trim()
    if (t) out.push({ source: "decide", text: clip(t), tags: ["plan", "step"] })
  }
  return out
}

/** Evaluate → memory: the judgment + reasoning (an outcome lesson). */
export function evaluateMemories(evalResult: EvaluateResult): MemoryWrite[] {
  const reasoning = evalResult.reasoning?.trim()
  if (!reasoning) return []
  return [{ source: "evaluate", text: clip(`${evalResult.judgment}: ${reasoning}`), tags: [evalResult.judgment] }]
}

// ---- Pure recall query builders ----

export function orientQuery(accumulatedEvents: ReadonlyArray<string>, emotionalWeight: string): string {
  return clip(`${emotionalWeight} ${accumulatedEvents.join(" ")}`.trim(), 400)
}
export function decideQuery(orient: OrientResult): string {
  return clip(`${orient.headline} ${orient.whatChanged}`.trim(), 400)
}
export function evaluateQuery(task: string, goal: string): string {
  return clip(`${task} ${goal}`.trim(), 400)
}

// ---- Pure recall formatter ----

/** Render hits as a prompt block under `label`; "" when no hits. Truncated to maxChars (+ ellipsis). */
export function formatRecall(hits: ReadonlyArray<MemoryHit>, label: string, maxChars?: number): string {
  if (hits.length === 0) return ""
  const block = `\n\n## ${label}\n${hits.map((h) => `- ${h.text}`).join("\n")}`
  if (maxChars && block.length > maxChars) return `${block.slice(0, maxChars)}…`
  return block
}

// ---- Service ----

const normalize = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ")
const DEDUP_CAP = 512

export interface MemoryGatewayApi {
  readonly remember: (containerId: string, char: CharacterConfig, write: MemoryWrite) => Effect.Effect<void, never>
  readonly recall: (
    containerId: string,
    char: CharacterConfig,
    query: string,
    opts: { readonly k: number; readonly label: string; readonly maxChars?: number; readonly tags?: ReadonlyArray<string> },
  ) => Effect.Effect<string, never>
}

export class MemoryGateway extends Context.Tag("MemoryGateway")<MemoryGateway, MemoryGatewayApi>() {}

export const MemoryGatewayLive: Layer.Layer<MemoryGateway, never, LongtermStore> = Layer.effect(
  MemoryGateway,
  Effect.gen(function* () {
    const store = yield* LongtermStore
    // Per-(container,char) rolling set of normalized texts written this process, for dedup.
    const seen = new Map<string, Set<string>>()
    const seenFor = (key: string): Set<string> => {
      let s = seen.get(key)
      if (!s) {
        s = new Set<string>()
        seen.set(key, s)
      }
      return s
    }
    return MemoryGateway.of({
      remember: (containerId, char, write) =>
        Effect.gen(function* () {
          const text = write.text.trim()
          if (!text) return
          const set = seenFor(`${containerId}:${char.name}`)
          const norm = normalize(text)
          if (set.has(norm)) return
          set.add(norm)
          if (set.size > DEDUP_CAP) {
            const oldest = set.values().next().value // Set preserves insertion order → oldest first
            if (oldest !== undefined) set.delete(oldest)
          }
          yield* store
            .remember(containerId, char, { text, source: write.source, tags: write.tags })
            .pipe(Effect.catchAll(() => Effect.void))
        }),
      recall: (containerId, char, query, opts) =>
        Effect.gen(function* () {
          const q = query.trim()
          if (!q) return ""
          const hits = yield* store
            .recall(containerId, char, q, { k: opts.k, tags: opts.tags })
            .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<MemoryHit>)))
          return formatRecall(hits, opts.label, opts.maxChars)
        }),
    })
  }),
)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest --run packages/core/src/conscious/memory-gateway.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/conscious/memory-gateway.ts packages/core/src/conscious/memory-gateway.test.ts
git commit -m "feat(memory): add MemoryGateway service with capture extractors, recall formatting, dedup"
```

---

### Task 3: Provision `MemoryGatewayLive` in the app layer stack

**Files:**
- Modify: `apps/roci/src/cli.ts` (import + `serviceLayer` merge, ~lines 14 and 708-710)

**Interfaces:**
- Consumes: `MemoryGatewayLive` (Task 2), existing `LongtermStoreLive`, `DockerLive`.
- Produces: `MemoryGateway` available in the app's runtime layer, satisfying the cortex loop's new requirement (Task 5).

- [ ] **Step 1: Add the import**

In `apps/roci/src/cli.ts`, next to the existing `LongtermStoreLive` import (line ~14):

```typescript
import { MemoryGatewayLive } from "@roci/core/conscious/memory-gateway.js"
```

- [ ] **Step 2: Add the layer to `serviceLayer`**

In the `Layer.mergeAll(...)` for `serviceLayer` (~line 708), after the `LongtermStoreLive.pipe(...)` entry, add:

```typescript
  // Memory policy seam (capture + recall) for the cortex loop. Depends on LongtermStore → Docker.
  MemoryGatewayLive.pipe(Layer.provide(LongtermStoreLive.pipe(Layer.provide(DockerLive)))),
```

- [ ] **Step 3: Verify the build passes**

Run: `pnpm build`
Expected: `Successfully ran target build for 4 projects` (no type errors). The loop does not yet depend on `MemoryGateway`, so this only proves the new layer wires cleanly.

- [ ] **Step 4: Commit**

```bash
git add apps/roci/src/cli.ts
git commit -m "feat(memory): provision MemoryGatewayLive in the app service layer"
```

---

### Task 4: Recall slot in prompts + `recalledMemories` param on tier callers

**Files:**
- Modify: `packages/core/src/skills/orient.md`, `packages/core/src/skills/decide.md`, `packages/core/src/skills/evaluate.md`
- Modify: `packages/core/src/cortex/tiers.ts` (`runForebrain`, `runConsciousDecide`, `runConsciousEvaluate`, `EvaluateInput`)
- Test: `packages/core/src/cortex/memory-recall-prompt.test.ts` (new)

**Interfaces:**
- Consumes: the `skills` template object already imported at the top of `tiers.ts` (reuse that exact import specifier in the test).
- Produces:
  - `runForebrain(config, accumulatedEvents, domainState, identity, emotionalWeight, recalledMemories?: string)` — 6th param, default `""`
  - `runConsciousDecide(config, orient, currentPlanState, availableActions, recalledMemories?: string)` — 5th param, default `""`
  - `EvaluateInput` gains `recalledMemories?: string`
  - Each of the three `.md` templates renders a `{{recalledMemories}}` slot.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/cortex/memory-recall-prompt.test.ts`. Match the `skills` import to the one used at the top of `tiers.ts` (check its first ~20 lines; e.g. `import { skills } from "../skills/index.js"`):

```typescript
import { describe, it, expect } from "vitest"
import { skills } from "../skills/index.js" // <-- match the specifier used in tiers.ts

const RECALL = "\n\n## You recall\n- the raider returns at dusk"

describe("recalled-memory prompt slot", () => {
  it("orient template renders the recalled block", () => {
    const out = skills.orient.render({
      cadence: "real-time", cadenceGuidance: "", accumulatedEvents: "", domainState: "",
      background: "", values: "", diary: "", emotionalWeight: "😐", recalledMemories: RECALL,
    })
    expect(out).toContain("## You recall")
    expect(out).toContain("the raider returns at dusk")
  })

  it("decide template renders the recalled block", () => {
    const out = skills.decide.render({
      cadence: "real-time", cadenceGuidance: "", headline: "", whatChanged: "", emotionalState: "😐",
      confidence: "high", sections: "", metrics: "{}", currentPlanState: "", availableSkills: "", recalledMemories: RECALL,
    })
    expect(out).toContain("## You recall")
  })

  it("evaluate template renders the recalled block", () => {
    const out = skills.evaluate.render({
      cadence: "real-time", cadenceGuidance: "", task: "", goal: "", successCondition: "",
      ticksBudgeted: "1", secondsBudgeted: "30", ticksConsumed: "1", secondsConsumed: "30", overrunWarning: "",
      executionReport: "", stateDiff: "", conditionCheck: "", emotionalState: "😐", remainingSteps: "None.",
      recalledMemories: RECALL,
    })
    expect(out).toContain("## You recall")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest --run packages/core/src/cortex/memory-recall-prompt.test.ts`
Expected: FAIL — the templates have no `{{recalledMemories}}` slot, so the block text is absent from the rendered output.

- [ ] **Step 3: Add the `{{recalledMemories}}` slot to each template**

In `packages/core/src/skills/orient.md`, insert a line containing only the slot immediately after the `{{cadenceGuidance}}` line (before the `## Accumulated Events Since Last Orientation` header):

```
{{recalledMemories}}
```

Do the same in `packages/core/src/skills/decide.md` and `packages/core/src/skills/evaluate.md`: locate the `{{cadenceGuidance}}` line and insert a standalone `{{recalledMemories}}` line right after it. (The gateway supplies a fully-formatted block or an empty string, so the slot needs no surrounding markup.)

- [ ] **Step 4: Thread the param through the tier callers**

In `packages/core/src/cortex/tiers.ts`:

`runForebrain` — add the 6th parameter and pass it into `render`:

```typescript
export function runForebrain(
  config: CortexRunnerConfig,
  accumulatedEvents: string[],
  domainState: string,
  identity: { background: string; values: string; diary: string },
  emotionalWeight: string,
  recalledMemories = "",
): Effect.Effect<OrientResult, ModelError | SpawnError | ReadinessError, ModelClient | ModelService | CharacterLog> {
  const prompt = skills.orient.render({
    cadence: config.cadence,
    cadenceGuidance: getCadenceGuidance("orient", config.cadence),
    accumulatedEvents: accumulatedEvents.join("\n\n"),
    domainState,
    background: identity.background,
    values: identity.values,
    diary: identity.diary,
    emotionalWeight,
    recalledMemories,
  })
  // ...rest unchanged
```

`runConsciousDecide` — add the 5th parameter and pass it into `render`:

```typescript
export function runConsciousDecide(
  config: CortexRunnerConfig,
  orient: OrientResult,
  currentPlanState: string,
  availableActions: string,
  recalledMemories = "",
): Effect.Effect<DecideResult, ModelError | SpawnError | ReadinessError, ModelClient | ModelService | CharacterLog> {
  const prompt = skills.decide.render({
    cadence: config.cadence,
    cadenceGuidance: getCadenceGuidance("decide", config.cadence),
    headline: orient.headline,
    whatChanged: orient.whatChanged,
    emotionalState: orient.emotionalState,
    confidence: orient.confidence,
    sections: (Array.isArray(orient.sections) ? orient.sections : [])
      .map((s) => `#### ${s.heading}\n${s.body}`)
      .join("\n\n"),
    metrics: JSON.stringify(orient.metrics, null, 2),
    currentPlanState,
    availableSkills: availableActions,
    recalledMemories,
  })
  // ...rest unchanged
```

`EvaluateInput` — add the optional field to its interface (defined in `tiers.ts`):

```typescript
  readonly recalledMemories?: string
```

`runConsciousEvaluate` — pass it into `render` (add to the existing render object):

```typescript
    recalledMemories: input.recalledMemories ?? "",
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest --run packages/core/src/cortex/memory-recall-prompt.test.ts`
Expected: PASS (all three).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/skills/orient.md packages/core/src/skills/decide.md packages/core/src/skills/evaluate.md packages/core/src/cortex/tiers.ts packages/core/src/cortex/memory-recall-prompt.test.ts
git commit -m "feat(memory): add recalled-memory prompt slot + tier-caller params"
```

---

### Task 5: Wire capture into the cortex loop

**Files:**
- Modify: `packages/core/src/cortex/loop.ts` (imports, service access, `R` type, four capture sites)
- Modify: any existing cortex loop test that provides a fixed layer set (add a fake `MemoryGateway`)

**Interfaces:**
- Consumes: `MemoryGateway` (Task 2), `observeMemories`/`orientMemories`/`decideMemories`/`evaluateMemories` (Task 2), `config.containerId`, `config.char`.
- Produces: on every non-discard boundary payload, a `gateway.remember` call. Adds `MemoryGateway` to `runCortex`'s requirements (`R`).

- [ ] **Step 1: Add imports and service access**

At the top of `packages/core/src/cortex/loop.ts`, add:

```typescript
import {
  MemoryGateway,
  observeMemories,
  orientMemories,
  decideMemories,
  evaluateMemories,
} from "../conscious/memory-gateway.js"
```

In the loop's `Effect.gen`, alongside the other `yield*` service acquisitions (~lines 106-112), add:

```typescript
    const memory = yield* MemoryGateway
```

- [ ] **Step 2: Add `MemoryGateway` to the loop's requirements type**

In the `as Effect.Effect<CortexResult, ..., | ...>` annotation (~lines 619-635), add a member to the `R` union:

```typescript
  | MemoryGateway
```

- [ ] **Step 3: Capture at the hindbrain observe boundary**

In the per-event appraisal loop (~lines 284-309), capture only the model-produced (non-inert) observes — `observeMemories` further drops `discard`:

```typescript
      for (const ev of tickEvents) {
        if (ev.inert) {
          appraisals.push({ event: ev.text, observe: INERT_APPRAISAL })
        } else {
          const observe = yield* runHindbrain(runnerConfig, ev.text, cortex.waitState)
          appraisals.push({ event: ev.text, observe })
          for (const w of observeMemories(observe)) {
            yield* memory.remember(config.containerId, config.char, w)
          }
        }
      }
```

- [ ] **Step 4: Capture at the orient and decide boundaries (idle path 5a)**

Immediately after `const orient = yield* runForebrain(...)` in the idle path (~line 325), add:

```typescript
          for (const w of orientMemories(orient)) {
            yield* memory.remember(config.containerId, config.char, w)
          }
```

Immediately after `const decide = yield* runConsciousDecide(...)` (~line 327), add:

```typescript
          for (const w of decideMemories(decide)) {
            yield* memory.remember(config.containerId, config.char, w)
          }
```

In the in-session steer path, after its `const orient = yield* runForebrain(...)` (~line 419), add the same orient capture loop:

```typescript
          for (const w of orientMemories(orient)) {
            yield* memory.remember(config.containerId, config.char, w)
          }
```

- [ ] **Step 5: Capture at the evaluate boundary (6a)**

Immediately after `const evalResult = yield* runConsciousEvaluate(...)` (~lines 470-485), add:

```typescript
            for (const w of evaluateMemories(evalResult)) {
              yield* memory.remember(config.containerId, config.char, w)
            }
```

- [ ] **Step 6: Update any loop test that provides a fixed layer set**

If `packages/core/src/cortex/loop.test.ts` (or any test that runs `runCortex`) exists, the new `MemoryGateway` requirement will break its build. Add this fake to the layers it provides:

```typescript
import { MemoryGateway } from "../conscious/memory-gateway.js"

const fakeMemory = Layer.succeed(
  MemoryGateway,
  MemoryGateway.of({
    remember: () => Effect.void,
    recall: () => Effect.succeed(""),
  }),
)
// ...merge `fakeMemory` into the layer provided to runCortex(...)
```

- [ ] **Step 7: Verify build and tests pass**

Run: `pnpm build && pnpm vitest --run packages/core/src/cortex`
Expected: build succeeds; cortex tests pass. (The capture *logic* is already covered by Task 2's pure-function tests; this step confirms the loop compiles and runs with the new dependency.)

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/cortex/loop.ts
git commit -m "feat(memory): capture structured facts at cortex phase boundaries"
```

---

### Task 6: Wire recall into the cortex loop

**Files:**
- Modify: `packages/core/src/cortex/loop.ts` (recall before orient/decide/evaluate; thread the block into the tier callers)

**Interfaces:**
- Consumes: `MemoryGateway.recall` (Task 2), `orientQuery`/`decideQuery`/`evaluateQuery` (Task 2), the `recalledMemories` params added in Task 4.
- Produces: memory-aware orient (capped), decide, and evaluate prompts.

- [ ] **Step 1: Add the query-builder imports**

Extend the memory-gateway import in `loop.ts` (Task 5, Step 1) with the query builders:

```typescript
import {
  MemoryGateway,
  observeMemories,
  orientMemories,
  decideMemories,
  evaluateMemories,
  orientQuery,
  decideQuery,
  evaluateQuery,
} from "../conscious/memory-gateway.js"
```

- [ ] **Step 2: Recall into orient — idle path (5a)**

Immediately before `const orient = yield* runForebrain(...)` in the idle path (~line 320), recall and pass the capped snippet as the new 6th arg:

```typescript
          const orientRecall = yield* memory.recall(
            config.containerId,
            config.char,
            orientQuery(cortex.accumulatedEvents, cortex.emotionalWeight),
            { k: 2, label: "You recall", maxChars: 300 },
          )
          const orient = yield* runForebrain(
            runnerConfig,
            cortex.accumulatedEvents,
            JSON.stringify(summary, null, 2),
            { background, values, diary },
            cortex.emotionalWeight,
            orientRecall,
          )
```

- [ ] **Step 3: Recall into decide (5a)**

Immediately before `const decide = yield* runConsciousDecide(...)` (~line 327), recall (richer, uncapped) and pass as the new 5th arg:

```typescript
          const decideRecall = yield* memory.recall(
            config.containerId,
            config.char,
            decideQuery(orient),
            { k: 5, label: "Relevant memories" },
          )
          const decide = yield* runConsciousDecide(runnerConfig, orient, "No active plan.", AVAILABLE_ACTIONS, decideRecall)
```

- [ ] **Step 4: Recall into orient — in-session steer path (5b)**

Immediately before `const orient = yield* runForebrain(...)` in the steer path (~line 413), add the same capped recall and pass it as the 6th arg:

```typescript
          const orientRecall = yield* memory.recall(
            config.containerId,
            config.char,
            orientQuery(cortex.accumulatedEvents, cortex.emotionalWeight),
            { k: 2, label: "You recall", maxChars: 300 },
          )
          const orient = yield* runForebrain(
            runnerConfig,
            cortex.accumulatedEvents,
            JSON.stringify(summary, null, 2),
            { background, values, diary },
            cortex.emotionalWeight,
            orientRecall,
          )
```

- [ ] **Step 5: Recall into evaluate (6a)**

Immediately before `const evalResult = yield* runConsciousEvaluate(...)` (~line 459), build the query from the step and pass the block via `recalledMemories`:

```typescript
            const evalRecall = yield* memory.recall(
              config.containerId,
              config.char,
              evaluateQuery(step.task, step.goal),
              { k: 5, label: "Relevant memories" },
            )
            const evalResult = yield* runConsciousEvaluate(runnerConfig, {
              task: step.task,
              goal: step.goal,
              successCondition: step.successCondition,
              ticksBudgeted: step.timeoutTicks,
              ticksConsumed,
              executionReport: formatExecutionReport(stepReport),
              stateDiff: renderer.stateDiff(stepStartSnapshot, after),
              conditionCheck,
              emotionalState: cortex.emotionalWeight,
              remainingSteps:
                steps
                  .slice(stepIdx + 1)
                  .map((s) => `${s.task}: ${s.goal}`)
                  .join("\n") || "None.",
              recalledMemories: evalRecall,
            })
```

- [ ] **Step 6: Verify build and tests pass**

Run: `pnpm build && pnpm vitest --run packages/core/src/cortex`
Expected: build succeeds; cortex tests pass. (Query-building and formatting are covered by Task 2's pure tests; the fake `MemoryGateway` from Task 5 returns `""` for recall, so existing loop tests are unaffected.)

- [ ] **Step 7: Full suite + typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck clean; full vitest suite green.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/cortex/loop.ts
git commit -m "feat(memory): inject recalled memories into orient (capped), decide, and evaluate"
```

---

## Notes / Risks (carried from the design)

- **Append-only store growth.** All-non-`discard` observe capture is the highest-volume source and the store has no cull. Dedup absorbs repeats within a process. If growth becomes a problem, the cheapest dial is switching `observeMemories` to capture only `disposition === "escalate"`; a proper retention/pruning pass is a separate follow-up.
- **Per-write docker exec latency.** Each `remember` is one `docker exec`. For v1 these run inline (best-effort). If the tick loop feels sluggish under event bursts, batch the observe captures (a batched `remember`-many analogous to the existing `promote` base64-stdin framing) or fork them — deferred until measured.
- **Forebrain fragility.** Orient recall is deliberately capped (`k: 2`, `maxChars: 300`). If orient JSON reliability regresses, disabling the two orient recall blocks (Steps 2 & 4 of Task 6) is the first mitigation; decide/evaluate recall are independent.
