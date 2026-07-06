# Meso retrospect Implementation Plan (Stage 4 of agent cognition extensions)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This plan **stacks on `feat/wm`** (Stage 2 committed through `75117a9`, Stage 3 committed through `cba8f3e`); there is no merge to `main` between the stages. Verify you are on `feat/wm` before starting (`git -C <worktree> branch --show-current`).

**Goal:** A new **meso retrospect** stage in `runReflection` (`packages/core/src/core/orchestrator/planned-action.ts:37-132`), placed **after the promote stage and before consolidate**, that grades the just-ended reflection cycle's episode streams (§1) against the character's skill index (§3) and **appends skill create/revise/retire proposals** to `players/<name>/me/growth/proposals.jsonl`. Each proposal must cite concrete episode evidence (step ids, per-skill verdict/tool stats) — a proposal with no evidence is **rejected at parse** and never stored. Meso **proposes only**: it never edits a skill file, never touches an identity file, never mutates the episode streams. Proposals accumulate across cycles (deduped, per-cycle-capped, total-capped) until the macro cycle (Stage 5) adjudicates and clears them. The retrospect turn follows the house reflection-turn pattern (`role:"brain"`, `noTools`, `runTurn` via the `claude` binary — like `dream`/`consolidate`), and its large input (the raw episode streams) is bounded **in code** to compact per-skill aggregates plus a short raw sample of the last N step-end records before it ever reaches the model. A retrospect failure is best-effort/never-fail — it must not disturb promote/consolidate/dream. SpaceMolt only; macro "growth stimulation" is Stage 5 and out of scope here, but this plan defines the exact read surface + record type Stage 5 consumes (spec §4 meso, `docs/superpowers/specs/2026-07-02-agent-cognition-extensions-design.md:100-127`).

**Architecture:** One new host-side module `packages/core/src/conscious/growth-store.ts` — the append-only proposals store, mirroring `wm-store.ts`'s host-side, never-fail, atomic-write style (NOT a `CharacterFs` surface; justified below). It holds the record type (`SkillProposal`), the caps, the code-side episode **aggregation** (`aggregateEpisodes` + `renderAggregate` + `renderRawSample`), the tolerant **proposal parser** (`parseProposals` — evidence-required, per-cycle-capped), and the store IO (`readProposals`/`appendProposals`, atomic whole-file rename, dedup + total cap). `packages/core/src/logging/episodes.ts` gains a **current-cycle reader** (`sliceCurrentCycle` pure + `readCurrentCycleEpisodes` Effect) so the retrospect reads the just-ended cycle's records **before** `finishEpisodeCycle` (`episodes.ts:214`) appends this cycle's boundary and rotates at the very end of `runReflection`. A new stage module `packages/core/src/core/limbic/hippocampus/retrospect.ts` (`retrospect.execute`, sibling to `dream`/`consolidate`) reads the streams, computes the bounded prompt, runs one brain turn, parses proposals, and appends them. `model-config.ts` gains a `"retrospect"` role; `behavior.ts`'s reflection event gains a `"retrospect"` stage. `runReflection` wires the stage in after promote, wrapped in the same `Effect.catchAll` best-effort discipline as every other stage.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Effect 3.x, `@effect/platform` `FileSystem` (via the `CharacterFs`/`runTurn` layers already provided to `runReflection`), vitest 3.x, pnpm + nx monorepo (`@roci/core` at `packages/core`, app `apps/roci`). No new dependencies.

## Global Constraints

- **Proposes only — never writes a skill or identity file (spec §4 meso, spec:110; Guardrails, spec:120-124):** the meso stage's only write is appending to `players/<name>/me/growth/proposals.jsonl`. It never calls `CharacterFs.writeSkill`, never touches a `me/skills/<slug>.md` file, and never touches `VALUES.md`/`background.md`/`DRIVES.md`/`DIARY.md`/`SECRETS.md`. Skill edits and identity writes are exclusively Stage 5 (macro), through `CharacterFs.writeSkill`'s cap gate.
- **Evidence required, rejected at parse (spec §4 Testing, spec:127; spec:110,123):** `SkillProposal.evidence` is a mandatory non-empty string citing concrete episode data. `parseProposals` **drops** any candidate whose `evidence` is missing/blank (also drops candidates missing a valid `action`, `skill`, or `summary`). A dropped candidate is never appended.
- **Never-fail / best-effort (spec §4 meso, spec:110; Testing, spec:127):** a retrospect failure must not disturb promote/consolidate/dream. Every `growth-store.ts` and `episodes.ts` reader/writer added here is `Effect<..., never, never>`, swallow-and-log (`console.error`), degrading to an empty result; `retrospect.execute` catches its own turn failure (blank/timeout/error → keep nothing, log, return `{ proposals: 0 }`); and the call site in `runReflection` is additionally wrapped `Effect.catchAll(logError)` exactly like the promote/consolidate/dream stages (`planned-action.ts:75-81,91-97,101-107`).
- **Bounded prompt (spec §1 Aggregates, spec:34; spec §4 meso, spec:109):** the raw episode streams are multi-KB (transition records carry full rendered prompts + outputs). The retrospect turn **never** sees those blobs. In code, `aggregateEpisodes` computes compact per-skill counts (steps, verdict tally, tool calls, tool failures) — the "aggregates computed at read time by retro turns" the spec calls for (spec:34) — and `renderRawSample` emits only the last `RETROSPECT_RAW_SAMPLE_STEPS` **step-end** records as one truncated line each (task/skill/verdict/transition only). This hybrid (compact aggregates + a small raw sample) fits a brain turn's budget.
- **No model turn on an empty cycle:** if the just-ended cycle produced no episode records (`tool` and `transition` both empty — e.g. `setEpisodeLogRoot` was never called, as in most unit tests), `retrospect.execute` returns `{ proposals: 0 }` **without** running a turn. This avoids a wasted turn and preserves the existing `planned-action.test.ts` `runTurn` call sequencing (those tests run with `episodeRoot` unset, so retrospect adds no call).
- **Append-only, atomic, deduped, capped (spec §4 meso, spec:110,126):** proposals accumulate until macro clears them. `appendProposals` is append-only in intent but persisted as an **atomic whole-file rewrite** (write-tmp-then-rename, same as `wm-store.ts`'s `writeAtomic`) so it can drop exact-duplicate proposals (by stable `id`) against the existing pending set and enforce a total cap (`MAX_PENDING_PROPOSALS`, keep newest) without a torn read. `parseProposals` caps a single cycle to `MAX_PROPOSALS_PER_CYCLE`.
- **Retrospect runs BEFORE rotation (spec §1 Rotation, spec:32; spec §4 meso):** `finishEpisodeCycle` (`planned-action.ts:131`) appends this cycle's `cycle-boundary` and rotates at the END of `runReflection`. `readCurrentCycleEpisodes` reads the tail past the *previous* boundary, so it must run before that append — the after-promote/before-consolidate placement satisfies this trivially.
- **SpaceMolt only (spec:5):** the GitHub domain is stale and out of scope; every seam is a domain-agnostic core seam (`runReflection` runs for all domains, but only SpaceMolt exercises it in scope).
- **Verification:** run from the worktree root `/Users/vcarl/workspace/roci/.claude/worktrees/skills` (`node_modules` installed). Tests: `pnpm vitest run <relative-test-path>`. Typecheck: `pnpm nx run-many -t typecheck --skip-nx-cache` — **always pass `--skip-nx-cache`** (nx caches typecheck and replays a stale green result across cross-package symbol changes).
- Conventional-commit messages; end every commit body with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Commit with `--no-verify`.

## File Structure

**New files:**
- `packages/core/src/conscious/growth-store.ts` — `SkillProposal`/`ProposalAction`, caps, `EpisodeAggregate`/`SkillAggregate`, `aggregateEpisodes`, `renderAggregate`, `renderRawSample`, `proposalKey`, `parseProposals`, `growthDir`/`proposalsJsonlPath`/`PROPOSALS_JSONL_FILE`, `readProposals`, `appendProposals`.
- `packages/core/src/conscious/growth-store.test.ts`
- `packages/core/src/core/limbic/hippocampus/retrospect.ts` — `retrospect` (`{ name, execute }`), `RetrospectInput`/`RetrospectOutput`, `RETROSPECT_RAW_SAMPLE_STEPS`, `buildRetrospectPrompt`.
- `packages/core/src/core/limbic/hippocampus/retrospect.test.ts`

**Modified files:**
- `packages/core/src/logging/episodes.ts` — Task 2: `sliceCurrentCycle` (pure) + `readCurrentCycleEpisodes` (Effect reader).
- `packages/core/src/logging/episodes.test.ts` — Task 2.
- `packages/core/src/core/model-config.ts:14` — Task 3: `Role` union gains `"retrospect"`.
- `packages/core/src/logging/behavior.ts:33` — Task 4: reflection `stage` union gains `"retrospect"`.
- `packages/core/src/core/orchestrator/planned-action.ts` — Task 4: retrospect stage wired after promote (`:81`→`:83`), import (`:8`-ish).
- `packages/core/src/core/orchestrator/planned-action.test.ts` — Task 4.

**Design decisions resolved up front (with justification, grounded in the code read):**

1. **A host-side `growth-store.ts` module, NOT a `CharacterFs` surface.** Two house patterns exist for `players/<name>/me/` state. `CharacterFs` (`services/CharacterFs.ts`) is an Effect *service* over `@effect/platform` `FileSystem`, returning a typed `CharacterFsError`, for **identity documents** re-read on escalation (diary/values/skills). `wm-store.ts` is a host-side, **never-fail** (`Effect<..., never, never>`, swallow-and-log), **atomic-write** module for **shared-mount JSONL/JSON logs** — and it explicitly frames itself as "the read surface Stage 4's retrospect consumes" (`wm-store.ts:15-17`). `proposals.jsonl` is exactly the second kind: an append-only log, written host-side during reflection, read host-side by macro, never touched by the in-container agent. It must degrade silently (a proposals write failing must not disturb reflection — spec:127), which is the never-fail discipline `CharacterFs` does *not* have (its writers fail with `CharacterFsError`). So `growth-store.ts` is a sibling of `wm-store.ts`/`episodes.ts`, and macro (Stage 5) reads it via `readProposals`.
2. **Placement: after promote, before consolidate.** Spec binds "after the promote stage so nothing is lost to the diary cull" (spec:110). Promote (`planned-action.ts:60-81`) and retrospect both **harvest the just-ended cycle's rawest substrate before any destructive rewrite** — promote reads the raw diary appends before consolidate overwrites them; retrospect reads the raw episode streams before `finishEpisodeCycle` rotates them. Grouping them keeps that "harvest, then rewrite" ordering explicit. There is **no data dependency** on consolidate/dream (retrospect reads the episode streams + skill index, which consolidate/dream never touch), so before-consolidate is safe; and placing it there means a slow/failing consolidate or dream (up to `REFLECTION_TURN_TIMEOUT_MS` = 8min each) can neither delay nor skip the retrospect. It trivially precedes `finishEpisodeCycle`'s end-of-reflection rotation (`planned-action.ts:131`).
3. **Read scope = the current (not-yet-closed) cycle.** `finishEpisodeCycle` appends this cycle's `cycle-boundary` marker only at the very end (`episodes.ts:218-232`), so at retrospect time the just-ended cycle is the stream tail past the *previous* boundary. `sliceCurrentCycle` returns exactly that tail (mirror of the existing `retainLastCycles` boundary scan, `episodes.ts:193-201`). Records are parsed tolerantly (a torn/garbled line is dropped, never thrown).
4. **Hybrid prompt bounding, computed in code.** Spec:34 says aggregates are computed at read time by retro turns, and spec:109 has the turn "read the cycle's episode streams." A brain turn cannot ingest the raw transition stream (full prompts+outputs, multi-KB per step). Resolution: the harness computes the aggregates in code (`aggregateEpisodes`) and passes the model a compact digest plus a bounded raw sample (`renderRawSample`, last N step-end lines, truncated) — the model does the *judgement*, the code does the *counting*. This is the only budget-safe reading of "read time by retro turns."
5. **Tolerant proposal extraction, self-contained.** The turn returns text. The prompt asks for a top-level `{"proposals":[...]}` object. `parseProposals` strips a ```` ```json ```` fence if present, `JSON.parse`s, and accepts either `{"proposals":[...]}` or a bare `[...]`, then validates+caps each element. This mirrors the spirit of `cortex/parse.ts`'s `extractJson`/`tryParseJson` but stays **self-contained in `growth-store.ts`** (no import of `cortex/parse.js`) to avoid a `conscious/`→`cortex/` import edge — `cortex/` already imports `conscious/` (`loop.ts`→`wm-store.ts`), and the reverse edge risks a cycle.

---

## Task 1: `growth-store.ts` — proposal record, aggregation, tolerant parse, append-only store

The host-side heart of the meso stage. Pure aggregation + parsing helpers plus a never-fail, atomic, deduped/capped proposals store — the exact read surface Stage 5 (macro) consumes.

**Files:**
- Create: `packages/core/src/conscious/growth-store.ts`
- Create: `packages/core/src/conscious/growth-store.test.ts`

**Interfaces:**
- Consumes: `CharacterConfig` (`services/CharacterFs.ts:26-29` — `char.dir` is the absolute `players/<name>/me/` path); `slugify` (`services/skills-core.ts:54`); `Judgment` (`skills/types.ts:98`); `ToolEpisode`/`TransitionEpisode`/`StepBoundaryEpisode` (`logging/episodes.ts:28,96,56`).
- Produces (Task 3 consumes the aggregation + parse + `appendProposals`; **Stage 5 (macro) consumes `readProposals` + the `SkillProposal` type + `proposalsJsonlPath`**):
  - `export type ProposalAction = "create" | "revise" | "retire"`
  - `export interface SkillProposal { id: string; ts: string; action: ProposalAction; skill: string; summary: string; body?: string; evidence: string; status: "pending" }`
  - `export const MAX_PROPOSALS_PER_CYCLE = 5`
  - `export const MAX_PENDING_PROPOSALS = 100`
  - `export interface SkillAggregate { skill: string; steps: number; verdicts: Record<Judgment, number>; toolCalls: number; toolFailures: number }`
  - `export interface EpisodeAggregate { totalSteps: number; totalToolCalls: number; totalToolFailures: number; perSkill: SkillAggregate[] }`
  - `export function aggregateEpisodes(tool: readonly ToolEpisode[], transition: readonly TransitionEpisode[]): EpisodeAggregate`
  - `export function renderAggregate(agg: EpisodeAggregate): string`
  - `export function renderRawSample(transition: readonly TransitionEpisode[], cap: number): string`
  - `export function proposalKey(action: ProposalAction, skill: string, summary: string): string`
  - `export function parseProposals(text: string, now: string): SkillProposal[]` — tolerant; evidence-required; caps to `MAX_PROPOSALS_PER_CYCLE`
  - `export const PROPOSALS_JSONL_FILE = "proposals.jsonl"`
  - `export function growthDir(char: CharacterConfig): string` / `export function proposalsJsonlPath(char: CharacterConfig): string`
  - `export const readProposals: (char: CharacterConfig) => Effect.Effect<SkillProposal[]>` — never-fails; missing file → `[]`
  - `export const appendProposals: (char: CharacterConfig, proposals: readonly SkillProposal[]) => Effect.Effect<number>` — never-fails; returns the count actually appended (after dedup)

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/conscious/growth-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { CharacterConfig } from "../services/CharacterFs.js"
import type { ToolEpisode, TransitionEpisode } from "../logging/episodes.js"
import {
  MAX_PROPOSALS_PER_CYCLE,
  MAX_PENDING_PROPOSALS,
  aggregateEpisodes,
  renderAggregate,
  renderRawSample,
  proposalKey,
  parseProposals,
  proposalsJsonlPath,
  readProposals,
  appendProposals,
  type SkillProposal,
} from "./growth-store.js"

const stepStart = (stepId: string, skill: string | null): TransitionEpisode => ({
  type: "step-start", ts: "t", tick: 1, stepId, task: "task " + stepId, goal: "g", skill, wmDeltas: null,
})
const stepEnd = (
  stepId: string, skill: string | null, verdict: "succeeded" | "partially_succeeded" | "failed",
): TransitionEpisode => ({
  type: "step-end", ts: "t", tick: 1, stepId, task: "task " + stepId, goal: "g",
  verdict, transition: "next_step", skill, wmDeltas: null,
})
const toolRec = (stepId: string | null, tool: string, status: string): ToolEpisode => ({
  ts: "t", tick: 1, stepId, tool, argsSummary: "{}", status, durationMs: 1,
})

describe("aggregateEpisodes", () => {
  it("tallies steps, per-skill verdicts, and joins tool calls/failures to skills via stepId", () => {
    const transition: TransitionEpisode[] = [
      stepStart("s1", "securing-fuel"), stepEnd("s1", "securing-fuel", "succeeded"),
      stepStart("s2", "securing-fuel"), stepEnd("s2", "securing-fuel", "failed"),
      stepStart("s3", null), stepEnd("s3", null, "succeeded"),
    ]
    const tool: ToolEpisode[] = [
      toolRec("s1", "bash", "completed"),
      toolRec("s2", "bash", "error"),
      toolRec("s2", "read", "error"),
      toolRec(null, "bash", "completed"), // untracked step → attributed to "(none)"
    ]
    const agg = aggregateEpisodes(tool, transition)
    expect(agg.totalSteps).toBe(3)
    expect(agg.totalToolCalls).toBe(4)
    expect(agg.totalToolFailures).toBe(2)
    const fuel = agg.perSkill.find((s) => s.skill === "securing-fuel")!
    expect(fuel.steps).toBe(2)
    expect(fuel.verdicts.succeeded).toBe(1)
    expect(fuel.verdicts.failed).toBe(1)
    expect(fuel.toolCalls).toBe(3)
    expect(fuel.toolFailures).toBe(2)
    const none = agg.perSkill.find((s) => s.skill === "(none)")!
    expect(none.steps).toBe(1)
    expect(none.toolCalls).toBe(1)
  })
})

describe("renderAggregate / renderRawSample — bounded, no raw prompt blobs", () => {
  it("renders compact per-skill lines and a step totals header", () => {
    const agg = aggregateEpisodes(
      [toolRec("s1", "bash", "error")],
      [stepStart("s1", "securing-fuel"), stepEnd("s1", "securing-fuel", "failed")],
    )
    const text = renderAggregate(agg)
    expect(text).toContain("1 steps")
    expect(text).toContain("securing-fuel")
    expect(text).toContain("1 failed")
  })
  it("raw sample is only the last N step-end lines, task-truncated, never full outputs", () => {
    const transition: TransitionEpisode[] = []
    for (let i = 0; i < 20; i++) transition.push(stepEnd(`s${i}`, "securing-fuel", "succeeded"))
    const sample = renderRawSample(transition, 5)
    const lines = sample.split("\n")
    expect(lines).toHaveLength(5) // capped to last 5
    expect(lines[0]).toContain("s15") // the last 5 are s15..s19
    expect(lines[4]).toContain("s19")
    expect(sample).toContain("verdict=succeeded")
  })
})

describe("parseProposals — evidence required, capped, tolerant", () => {
  const now = "2026-07-03T00:00:00.000Z"
  it("keeps a well-formed proposal with evidence and assigns id/ts/status", () => {
    const out = parseProposals(
      JSON.stringify({
        proposals: [
          { action: "revise", skill: "securing-fuel", summary: "Top up earlier", body: "new body", evidence: "steps s2 failed; 2 tool failures" },
        ],
      }),
      now,
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      action: "revise", skill: "securing-fuel", summary: "Top up earlier", body: "new body",
      evidence: "steps s2 failed; 2 tool failures", status: "pending", ts: now,
    })
    expect(out[0].id).toBe(proposalKey("revise", "securing-fuel", "Top up earlier"))
  })
  it("REJECTS a proposal with no evidence (spec §4)", () => {
    const out = parseProposals(
      JSON.stringify({ proposals: [{ action: "create", skill: "x", summary: "s", evidence: "  " }] }),
      now,
    )
    expect(out).toEqual([])
  })
  it("REJECTS proposals missing action/skill/summary, keeps the valid ones", () => {
    const out = parseProposals(
      JSON.stringify({
        proposals: [
          { action: "bogus", skill: "a", summary: "s", evidence: "e" },
          { action: "retire", skill: "", summary: "s", evidence: "e" },
          { action: "retire", skill: "stale", summary: "", evidence: "e" },
          { action: "retire", skill: "stale", summary: "unused all cycle", evidence: "0 steps worn" },
        ],
      }),
      now,
    )
    expect(out.map((p) => p.action)).toEqual(["retire"])
    expect(out[0].body).toBeUndefined() // retire carries no body
  })
  it("tolerates a ```json fence and a bare array, and caps to MAX_PROPOSALS_PER_CYCLE", () => {
    const many = Array.from({ length: MAX_PROPOSALS_PER_CYCLE + 3 }, (_, i) => ({
      action: "create", skill: `s${i}`, summary: `sum ${i}`, evidence: `ev ${i}`,
    }))
    const fenced = "```json\n" + JSON.stringify(many) + "\n```"
    expect(parseProposals(fenced, now)).toHaveLength(MAX_PROPOSALS_PER_CYCLE)
  })
  it("returns [] on garbage (never throws)", () => {
    expect(parseProposals("not json at all", now)).toEqual([])
    expect(parseProposals("", now)).toEqual([])
  })
})

describe("readProposals / appendProposals — atomic, dedup, total cap, never-fail", () => {
  let root: string
  let char: CharacterConfig
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "growth-"))
    char = { name: "ada", dir: path.join(root, "players", "ada", "me") }
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const mkProps = (n: number): SkillProposal[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `id-${i}`, ts: "t", action: "create" as const, skill: `s${i}`,
      summary: `sum ${i}`, evidence: `ev ${i}`, status: "pending" as const,
    }))

  it("missing file → readProposals returns []", async () => {
    expect(await Effect.runPromise(readProposals(char))).toEqual([])
  })
  it("appends, persists atomically, and reads back", async () => {
    const n = await Effect.runPromise(appendProposals(char, mkProps(2)))
    expect(n).toBe(2)
    expect(fs.existsSync(proposalsJsonlPath(char))).toBe(true)
    const read = await Effect.runPromise(readProposals(char))
    expect(read.map((p) => p.id)).toEqual(["id-0", "id-1"])
  })
  it("dedups exact-duplicate ids against the existing pending set", async () => {
    await Effect.runPromise(appendProposals(char, mkProps(2)))
    const appended = await Effect.runPromise(appendProposals(char, mkProps(3))) // id-0,id-1 dup; id-2 new
    expect(appended).toBe(1)
    expect((await Effect.runPromise(readProposals(char))).map((p) => p.id)).toEqual(["id-0", "id-1", "id-2"])
  })
  it("enforces MAX_PENDING_PROPOSALS by keeping the newest", async () => {
    const first = Array.from({ length: MAX_PENDING_PROPOSALS }, (_, i) => ({ ...mkProps(1)[0], id: `a-${i}` }))
    await Effect.runPromise(appendProposals(char, first))
    await Effect.runPromise(appendProposals(char, [{ ...mkProps(1)[0], id: "z-new" }]))
    const read = await Effect.runPromise(readProposals(char))
    expect(read).toHaveLength(MAX_PENDING_PROPOSALS)
    expect(read[read.length - 1].id).toBe("z-new") // newest kept
    expect(read.some((p) => p.id === "a-0")).toBe(false) // oldest dropped
  })
  it("never throws when the growth dir path is unwritable", async () => {
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, "players"), "not a directory") // mkdir -p will fail
    await expect(Effect.runPromise(appendProposals(char, mkProps(1)))).resolves.toBe(0)
  })
})
```

- [ ] **Step 2: Run it, expect failure**

```
pnpm vitest run packages/core/src/conscious/growth-store.test.ts
```

Expected failure: `Failed to resolve import "./growth-store.js"`.

- [ ] **Step 3: Implement**

Create `packages/core/src/conscious/growth-store.ts`:

```ts
/**
 * Host-side growth-proposal store (agent-cognition Stage 4 — meso retrospect, spec §4).
 *
 * players/<name>/me/growth/proposals.jsonl — append-only JSONL on the shared
 * mount. The per-cycle meso retrospect APPENDS skill create/revise/retire
 * proposals here; proposals accumulate across cycles until the macro cycle
 * (Stage 5) adjudicates and clears them. Meso PROPOSES ONLY — it never edits a
 * skill file or an identity file.
 *
 * Discipline (same as wm-store.ts / episodes.ts): a proposals write must never
 * disturb reflection. Every reader/writer here is Effect<..., never, never> —
 * failures are swallowed after a console.error and degrade to an empty result.
 * Append is persisted as an ATOMIC whole-file rewrite (write-tmp + rename), so
 * dedup and the total cap are enforced without a reader ever seeing a torn file.
 *
 * Read surface for Stage 5 (macro): `readProposals(char)` returns every pending
 * proposal (the SkillProposal[] the adjudicator weighs); `proposalsJsonlPath`
 * locates the file the macro rewrites after adjudication.
 */
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import { Effect } from "effect"
import type { CharacterConfig } from "../services/CharacterFs.js"
import { slugify } from "../services/skills-core.js"
import type { Judgment } from "../skills/types.js"
import type { ToolEpisode, TransitionEpisode, StepBoundaryEpisode } from "../logging/episodes.js"

/** A skill change the meso stage proposes for the macro cycle to adjudicate. */
export type ProposalAction = "create" | "revise" | "retire"

/**
 * One accumulated proposal. `evidence` is MANDATORY (spec §4): a proposal that
 * cites no concrete episode data is rejected at parse. `status` is reserved for
 * Stage 5, which flips it to accepted/rejected during adjudication.
 */
export interface SkillProposal {
  /** Stable dedup id: action + skill-slug + normalized summary (see proposalKey). */
  id: string
  /** ISO timestamp the retrospect wrote this proposal. */
  ts: string
  action: ProposalAction
  /** Target skill NAME (create: proposed new name; revise/retire: an existing name). */
  skill: string
  /** One line: what to change and why. */
  summary: string
  /** create/revise: the proposed new body. Omitted for retire. */
  body?: string
  /** REQUIRED concrete episode evidence — step ids, per-skill verdict/tool stats. */
  evidence: string
  /** Reserved for Stage 5: "pending" until the macro cycle adjudicates. */
  status: "pending"
}

/** At most this many proposals from a single retrospect cycle. */
export const MAX_PROPOSALS_PER_CYCLE = 5
/** Hard cap on the accumulated pending file between macro runs (keep newest). */
export const MAX_PENDING_PROPOSALS = 100

// ── Episode aggregation (code-side; the "aggregates computed at read time") ──
export interface SkillAggregate {
  /** Worn skill name, or "(none)" for steps run with no skill. */
  skill: string
  steps: number
  verdicts: Record<Judgment, number>
  toolCalls: number
  toolFailures: number
}

export interface EpisodeAggregate {
  totalSteps: number
  totalToolCalls: number
  totalToolFailures: number
  perSkill: SkillAggregate[]
}

const NONE = "(none)"

function isStepBoundary(rec: TransitionEpisode): rec is StepBoundaryEpisode {
  return rec.type === "step-start" || rec.type === "step-end"
}

function emptyVerdicts(): Record<Judgment, number> {
  return { succeeded: 0, partially_succeeded: 0, failed: 0 }
}

/**
 * Compact per-skill counts from the just-ended cycle's two streams. Step-end
 * records supply steps + verdicts; tool records are joined to the skill worn on
 * their stepId (from the step-start/step-end skill stamp — spec §3). This is the
 * only signal the retrospect turn needs; the raw prompt/output blobs on
 * transition records are deliberately NOT read here (prompt-budget).
 */
export function aggregateEpisodes(
  tool: readonly ToolEpisode[],
  transition: readonly TransitionEpisode[],
): EpisodeAggregate {
  const stepSkill = new Map<string, string>()
  const per = new Map<string, SkillAggregate>()
  const bucket = (skill: string | null): SkillAggregate => {
    const key = skill ?? NONE
    let b = per.get(key)
    if (!b) {
      b = { skill: key, steps: 0, verdicts: emptyVerdicts(), toolCalls: 0, toolFailures: 0 }
      per.set(key, b)
    }
    return b
  }

  for (const rec of transition) {
    if (!isStepBoundary(rec)) continue
    stepSkill.set(rec.stepId, rec.skill ?? NONE)
    if (rec.type === "step-end") {
      const b = bucket(rec.skill)
      b.steps++
      if (rec.verdict) b.verdicts[rec.verdict]++
    }
  }

  let totalToolCalls = 0
  let totalToolFailures = 0
  for (const t of tool) {
    totalToolCalls++
    const failed = t.status === "error"
    if (failed) totalToolFailures++
    const skill = t.stepId != null ? stepSkill.get(t.stepId) ?? NONE : NONE
    const b = bucket(skill)
    b.toolCalls++
    if (failed) b.toolFailures++
  }

  const perSkill = [...per.values()].sort((a, b) => b.steps - a.steps || a.skill.localeCompare(b.skill))
  const totalSteps = perSkill.reduce((n, s) => n + s.steps, 0)
  return { totalSteps, totalToolCalls, totalToolFailures, perSkill }
}

/** Compact human-readable digest of the aggregates for the retrospect prompt. */
export function renderAggregate(agg: EpisodeAggregate): string {
  const head = `Cycle totals: ${agg.totalSteps} steps, ${agg.totalToolCalls} tool calls, ${agg.totalToolFailures} failed.`
  if (agg.perSkill.length === 0) return `${head}\n(no per-skill activity recorded)`
  const rows = agg.perSkill.map(
    (s) =>
      `- ${s.skill}: ${s.steps} steps (succeeded ${s.verdicts.succeeded}, partial ${s.verdicts.partially_succeeded}, failed ${s.verdicts.failed}); ${s.toolCalls} tool calls, ${s.toolFailures} failed`,
  )
  return [head, ...rows].join("\n")
}

const truncate = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}…`)

/**
 * A bounded raw sample: only the last `cap` step-END records, one truncated line
 * each (task/skill/verdict/transition). Never emits the full rendered prompts or
 * outputs the transition stream also carries — that is what keeps the prompt
 * within a brain turn's budget.
 */
export function renderRawSample(transition: readonly TransitionEpisode[], cap: number): string {
  const ends = transition.filter((r): r is StepBoundaryEpisode => r.type === "step-end")
  const tail = ends.slice(-cap)
  if (tail.length === 0) return "(no completed steps this cycle)"
  return tail
    .map(
      (s) =>
        `- [${s.stepId}] skill=${s.skill ?? NONE} verdict=${s.verdict ?? "?"} transition=${s.transition ?? "?"} :: ${truncate(s.task, 120)}`,
    )
    .join("\n")
}

// ── Proposal parsing (tolerant; evidence-required; capped) ───────────────────
/** Stable dedup identity: action + slugified skill + normalized summary. */
export function proposalKey(action: ProposalAction, skill: string, summary: string): string {
  return `${action}:${slugify(skill)}:${summary.trim().toLowerCase().replace(/\s+/g, " ")}`
}

function isAction(x: unknown): x is ProposalAction {
  return x === "create" || x === "revise" || x === "retire"
}

/**
 * Pull the proposals array out of a brain turn's text. Strips a ```json/``` fence
 * if present, then accepts either a top-level `{"proposals":[...]}` object (what
 * the prompt asks for) or a bare `[...]`. Never throws. Kept self-contained (no
 * cortex/parse import) to avoid a conscious/ -> cortex/ import cycle.
 */
function extractProposalsArray(text: string): unknown[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = (fenced ? fenced[1] : text).trim()
  if (!body) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return []
  }
  if (Array.isArray(parsed)) return parsed
  if (parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { proposals?: unknown }).proposals)) {
    return (parsed as { proposals: unknown[] }).proposals
  }
  return []
}

/**
 * Parse + validate the turn's proposals. Drops any candidate missing a valid
 * `action`, a non-empty `skill`/`summary`, or (spec §4) a non-empty `evidence`.
 * Assigns the stable id/ts/status and caps to MAX_PROPOSALS_PER_CYCLE.
 */
export function parseProposals(text: string, now: string): SkillProposal[] {
  const out: SkillProposal[] = []
  for (const el of extractProposalsArray(text)) {
    if (el === null || typeof el !== "object" || Array.isArray(el)) continue
    const e = el as Record<string, unknown>
    if (!isAction(e.action)) continue
    const skill = typeof e.skill === "string" ? e.skill.trim() : ""
    if (!skill) continue
    const summary = typeof e.summary === "string" ? e.summary.trim() : ""
    if (!summary) continue
    const evidence = typeof e.evidence === "string" ? e.evidence.trim() : ""
    if (!evidence) continue // evidence REQUIRED — rejected at parse (spec §4)
    const body = typeof e.body === "string" ? e.body : undefined
    out.push({
      id: proposalKey(e.action, skill, summary),
      ts: now,
      action: e.action,
      skill,
      summary,
      ...(body !== undefined ? { body } : {}),
      evidence,
      status: "pending",
    })
    if (out.length >= MAX_PROPOSALS_PER_CYCLE) break
  }
  return out
}

// ── Store IO (never fails) ───────────────────────────────────────────────────
export const PROPOSALS_JSONL_FILE = "proposals.jsonl"
export function growthDir(char: CharacterConfig): string {
  return path.join(char.dir, "growth")
}
export function proposalsJsonlPath(char: CharacterConfig): string {
  return path.join(growthDir(char), PROPOSALS_JSONL_FILE)
}

/** Tolerant validator for a stored line (the file may be hand-edited). */
function isStoredProposal(rec: unknown): rec is SkillProposal {
  if (rec === null || typeof rec !== "object" || Array.isArray(rec)) return false
  const r = rec as Record<string, unknown>
  return (
    typeof r.id === "string" &&
    isAction(r.action) &&
    typeof r.skill === "string" &&
    typeof r.summary === "string" &&
    typeof r.evidence === "string" &&
    r.evidence.trim().length > 0 &&
    r.status === "pending"
  )
}

const loadProposals = async (char: CharacterConfig): Promise<SkillProposal[]> => {
  try {
    const text = await fsp.readFile(proposalsJsonlPath(char), "utf8")
    const out: SkillProposal[] = []
    for (const line of text.split("\n")) {
      const t = line.trim()
      if (!t) continue
      try {
        const rec = JSON.parse(t)
        if (isStoredProposal(rec)) out.push(rec)
      } catch {
        // drop a torn/garbled line, keep the rest
      }
    }
    return out
  } catch {
    return []
  }
}

/** Read all pending proposals (Stage 5 macro read surface). Never fails. */
export const readProposals = (char: CharacterConfig): Effect.Effect<SkillProposal[]> =>
  Effect.promise(() => loadProposals(char))

/**
 * Append proposals: drop ids already pending (exact-duplicate dedup), enforce
 * the total cap by keeping the newest MAX_PENDING_PROPOSALS, and persist the
 * whole set atomically (write-tmp + rename). Returns the number actually
 * appended. Never fails — a write error logs and returns 0.
 */
export const appendProposals = (
  char: CharacterConfig,
  proposals: readonly SkillProposal[],
): Effect.Effect<number> =>
  Effect.promise(async () => {
    try {
      if (proposals.length === 0) return 0
      const existing = await loadProposals(char)
      const seen = new Set(existing.map((p) => p.id))
      const fresh = proposals.filter((p) => !seen.has(p.id))
      if (fresh.length === 0) return 0
      let all = existing.concat(fresh)
      if (all.length > MAX_PENDING_PROPOSALS) all = all.slice(all.length - MAX_PENDING_PROPOSALS)
      await fsp.mkdir(growthDir(char), { recursive: true })
      const file = proposalsJsonlPath(char)
      const tmp = `${file}.tmp.${process.pid}.${crypto.randomUUID()}`
      await fsp.writeFile(tmp, `${all.map((p) => JSON.stringify(p)).join("\n")}\n`, "utf8")
      await fsp.rename(tmp, file)
      return fresh.length
    } catch (e) {
      console.error(`[growth] append failed for ${char.name}: ${e}`)
      return 0
    }
  })
```

- [ ] **Step 4: Run it, expect pass; typecheck + commit**

```
pnpm vitest run packages/core/src/conscious/growth-store.test.ts
pnpm nx run-many -t typecheck --skip-nx-cache
git add packages/core/src/conscious/growth-store.ts packages/core/src/conscious/growth-store.test.ts
git commit --no-verify -m "feat(growth): proposals store — record, aggregation, tolerant parse, append

Host-side heart of the meso retrospect (spec §4): the SkillProposal record,
code-side episode aggregation (per-skill steps/verdicts/tool-failures + a
bounded raw sample), the evidence-required tolerant proposal parser (capped per
cycle), and the never-fail atomic append-only store (dedup by id, total cap).
readProposals + proposalsJsonlPath are the Stage 5 macro read surface.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: episode current-cycle reader — `sliceCurrentCycle` + `readCurrentCycleEpisodes`

The retrospect must read the just-ended cycle's records BEFORE `finishEpisodeCycle` appends this cycle's boundary and rotates (spec §1 Rotation, spec:32). `episodes.ts` owns `episodeRoot` and the file constants, so the reader lives there.

**Files:**
- Modify: `packages/core/src/logging/episodes.ts` (add after `retainLastCycles`, `:201`)
- Modify: `packages/core/src/logging/episodes.test.ts`

**Interfaces:**
- Consumes: the module-private `episodeRoot`/`logsDir`/`lineType` and the exported `TOOL_EPISODE_FILE`/`TRANSITION_EPISODE_FILE` (`episodes.ts:24-25,103-112,179-186`).
- Produces (Task 3 consumes):
  - `export function sliceCurrentCycle(lines: readonly string[]): string[]` — the lines AFTER the last `cycle-boundary` (all lines if none)
  - `export const readCurrentCycleEpisodes: (character: string) => Effect.Effect<{ tool: ToolEpisode[]; transition: TransitionEpisode[] }>` — never-fails; `episodeRoot` unset or missing files → empty arrays

- [ ] **Step 1: Write the failing test**

In `packages/core/src/logging/episodes.test.ts`, append a new describe (the file already imports `setEpisodeLogRoot` and the append writers; add `sliceCurrentCycle`, `readCurrentCycleEpisodes`, `appendTransitionEpisode`, and `finishEpisodeCycle` to the `./episodes.js` import, and `fs`/`os`/`path` if not present):

```ts
describe("sliceCurrentCycle / readCurrentCycleEpisodes", () => {
  it("sliceCurrentCycle returns the tail past the last cycle-boundary", () => {
    const lines = [
      JSON.stringify({ type: "step-end", stepId: "a" }),
      JSON.stringify({ type: "cycle-boundary", ts: "t1" }),
      JSON.stringify({ type: "step-end", stepId: "b" }),
      JSON.stringify({ type: "step-end", stepId: "c" }),
    ]
    expect(sliceCurrentCycle(lines)).toEqual([lines[2], lines[3]])
  })
  it("sliceCurrentCycle returns all lines when there is no boundary", () => {
    const lines = [JSON.stringify({ type: "step-end", stepId: "a" })]
    expect(sliceCurrentCycle(lines)).toEqual(lines)
  })

  it("reads only the current (not-yet-closed) cycle from both streams", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "episodes-cur-"))
    setEpisodeLogRoot(root)
    try {
      // Prior cycle: one tool call + one step, then a boundary.
      await Effect.runPromise(appendToolEpisode("ada", {
        ts: "t", tick: 1, stepId: "old", tool: "bash", argsSummary: "{}", status: "completed", durationMs: 1,
      }))
      await Effect.runPromise(appendTransitionEpisode("ada", {
        type: "step-end", ts: "t", tick: 1, stepId: "old", task: "old", goal: "g",
        verdict: "succeeded", transition: "next_step", skill: null, wmDeltas: null,
      }))
      await Effect.runPromise(finishEpisodeCycle("ada")) // closes cycle 1

      // Current cycle: one new tool call + step-end.
      await Effect.runPromise(appendToolEpisode("ada", {
        ts: "t", tick: 2, stepId: "new", tool: "read", argsSummary: "{}", status: "error", durationMs: 1,
      }))
      await Effect.runPromise(appendTransitionEpisode("ada", {
        type: "step-end", ts: "t", tick: 2, stepId: "new", task: "new", goal: "g",
        verdict: "failed", transition: "next_step", skill: "securing-fuel", wmDeltas: null,
      }))

      const { tool, transition } = await Effect.runPromise(readCurrentCycleEpisodes("ada"))
      expect(tool.map((t) => t.stepId)).toEqual(["new"])
      expect(transition.filter((r) => r.type === "step-end").map((r) => (r as { stepId: string }).stepId)).toEqual(["new"])
    } finally {
      setEpisodeLogRoot(null)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("returns empty arrays when the episode root is unset", async () => {
    setEpisodeLogRoot(null)
    expect(await Effect.runPromise(readCurrentCycleEpisodes("ghost"))).toEqual({ tool: [], transition: [] })
  })
})
```

- [ ] **Step 2: Run it, expect failure**

```
pnpm vitest run packages/core/src/logging/episodes.test.ts -t "sliceCurrentCycle"
```

Expected: `sliceCurrentCycle`/`readCurrentCycleEpisodes` are not exported.

- [ ] **Step 3: Implement**

In `packages/core/src/logging/episodes.ts`, after `retainLastCycles` (ends `:201`), add:

```ts
/**
 * Pure. The lines of the current (not-yet-closed) reflection cycle: everything
 * AFTER the last `cycle-boundary` marker, or all lines if none. The meso
 * retrospect runs BEFORE finishEpisodeCycle appends this cycle's boundary, so
 * this is exactly the just-ended cycle's records.
 */
export function sliceCurrentCycle(lines: readonly string[]): string[] {
  let last = -1
  lines.forEach((line, i) => {
    if (lineType(line) === "cycle-boundary") last = i
  })
  return lines.slice(last + 1)
}

async function readCurrentStream<T>(root: string, character: string, file: string): Promise<T[]> {
  try {
    const text = await fsp.readFile(path.join(logsDir(root, character), file), "utf8")
    const lines = text.split("\n").filter((l) => l.trim().length > 0)
    const out: T[] = []
    for (const line of sliceCurrentCycle(lines)) {
      try {
        out.push(JSON.parse(line) as T)
      } catch {
        // drop a torn/garbled line, keep the rest
      }
    }
    return out
  } catch {
    return []
  }
}

/**
 * Read the just-ended cycle's records from both streams (for the meso
 * retrospect, spec §4). Never fails: an unset root or a missing file degrades to
 * empty arrays. Reads only the current cycle (past the last boundary), so it is
 * safe to call right before finishEpisodeCycle's rotation.
 */
export const readCurrentCycleEpisodes = (
  character: string,
): Effect.Effect<{ tool: ToolEpisode[]; transition: TransitionEpisode[] }> => {
  const root = episodeRoot
  if (root === null) return Effect.succeed({ tool: [], transition: [] })
  return Effect.promise(async () => ({
    tool: await readCurrentStream<ToolEpisode>(root, character, TOOL_EPISODE_FILE),
    transition: await readCurrentStream<TransitionEpisode>(root, character, TRANSITION_EPISODE_FILE),
  }))
}
```

- [ ] **Step 4: Run the full episodes suite, typecheck + commit**

```
pnpm vitest run packages/core/src/logging/episodes.test.ts
pnpm nx run-many -t typecheck --skip-nx-cache
git add packages/core/src/logging/episodes.ts packages/core/src/logging/episodes.test.ts
git commit --no-verify -m "feat(episodes): current-cycle reader for the meso retrospect

sliceCurrentCycle (pure) + readCurrentCycleEpisodes (never-fail Effect) read the
just-ended cycle's tool + transition records — the tail past the last
cycle-boundary — so the retrospect can grade them BEFORE finishEpisodeCycle
appends this cycle's boundary and rotates.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: `retrospect.ts` stage — bounded prompt, brain turn, parse + append

The stage module, sibling to `dream`/`consolidate`. Reads the streams, bounds the prompt in code, runs one `role:"brain"` `noTools` turn, parses evidence-bearing proposals, and appends them. Never-fail: a blank/timed-out/errored turn keeps nothing and returns `{ proposals: 0 }`.

**Files:**
- Create: `packages/core/src/core/limbic/hippocampus/retrospect.ts`
- Create: `packages/core/src/core/limbic/hippocampus/retrospect.test.ts`
- Modify: `packages/core/src/core/model-config.ts:14` (`Role` union gains `"retrospect"`)

**Interfaces:**
- Consumes: `readCurrentCycleEpisodes` (Task 2); `aggregateEpisodes`/`renderAggregate`/`renderRawSample`/`parseProposals`/`appendProposals` (Task 1); `renderSkillIndex`/`SkillMeta` (`services/skills-core.ts:120,41`); `runTurn` (`hypothalamus/process-runner.ts:101`); `resolveModel`/`ModelConfig` (`model-config.ts:41,16`); `REFLECTION_TURN_TIMEOUT_MS` (`hippocampus/dream.ts:26`); `CharacterFs`, `CharacterLog`, `logError`.
- Produces (Task 4 consumes):
  - `export const RETROSPECT_RAW_SAMPLE_STEPS = 12`
  - `export function buildRetrospectPrompt(parts: { index: string; aggregate: string; sample: string }): string`
  - `export interface RetrospectInput { char: CharacterConfig; containerId: string; playerName: string; addDirs?: string[]; env?: Record<string, string>; models: ModelConfig }`
  - `export interface RetrospectOutput { proposals: number }`
  - `export const retrospect: { name: "retrospect"; execute: (input: RetrospectInput) => Effect.Effect<RetrospectOutput, never, CharacterFs | CharacterLog | CommandExecutor.CommandExecutor | OAuthToken> }`

- [ ] **Step 1: Add the `"retrospect"` model role**

In `packages/core/src/core/model-config.ts`, extend the `Role` union (`:14`):

```ts
export type Role = "dreamCompression" | "dinner" | "retrospect"
```

(No `DEFAULT_MODEL_CONFIG.roles` entry: `retrospect` resolves to the `smart` tier by default — the same default the `dinner`/consolidate reflection turn uses — and stays overridable per deployment.)

- [ ] **Step 2: Write the failing test**

Create `packages/core/src/core/limbic/hippocampus/retrospect.test.ts` (mirrors `dream.test.ts`'s `runTurn` mock + stub layers idiom):

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { CommandExecutor } from "@effect/platform"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const { runTurnMock } = vi.hoisted(() => ({ runTurnMock: vi.fn() }))
vi.mock("../hypothalamus/process-runner.js", () => ({ runTurn: runTurnMock }))

import { retrospect, buildRetrospectPrompt } from "./retrospect.js"
import { CharacterFs } from "../../../services/CharacterFs.js"
import { CharacterLog } from "../../../logging/log-writer.js"
import { OAuthToken } from "../../../services/OAuthToken.js"
import { DEFAULT_MODEL_CONFIG } from "../../model-config.js"
import { setEpisodeLogRoot, appendToolEpisode, appendTransitionEpisode } from "../../../logging/episodes.js"
import { readProposals, proposalsJsonlPath } from "../../../conscious/growth-store.js"

const StubCommandExecutor = Layer.succeed(
  CommandExecutor.CommandExecutor,
  { start: () => { throw new Error("stub") } } as unknown as CommandExecutor.CommandExecutor,
)
const StubOAuthToken = Layer.succeed(
  OAuthToken,
  OAuthToken.of({ getToken: Effect.succeed({ token: "stub", version: 0 }), validateInContainer: () => Effect.succeed(true) }),
)

function fsLayer(skills: Array<{ slug: string; name: string; description: string; whenToUse: string }>) {
  return Layer.succeed(
    CharacterFs,
    CharacterFs.of({
      readDiary: () => Effect.succeed(""), writeDiary: () => Effect.void,
      readSecrets: () => Effect.succeed(""), writeSecrets: () => Effect.void,
      readCredentials: () => Effect.succeed({ username: "", password: "" }),
      readBackground: () => Effect.succeed(""), readValues: () => Effect.succeed(""),
      readPalette: () => Effect.succeed(""), readDrives: () => Effect.succeed(""),
      characterExists: () => Effect.succeed(true),
      listSkills: () => Effect.succeed(skills),
      readSkill: () => Effect.succeed(null), writeSkill: () => Effect.void,
    }),
  )
}
function logLayer(errors: string[]) {
  return Layer.succeed(
    CharacterLog,
    CharacterLog.of({ emit: (_c, e) => Effect.sync(() => { if (e.kind === "error") errors.push(e.message) }) }),
  )
}

let root: string
let char: { name: string; dir: string }
beforeEach(() => {
  runTurnMock.mockReset()
  root = fs.mkdtempSync(path.join(os.tmpdir(), "retro-"))
  char = { name: "ada", dir: path.join(root, "players", "ada", "me") }
  setEpisodeLogRoot(root)
})
afterEach(() => {
  setEpisodeLogRoot(null)
  fs.rmSync(root, { recursive: true, force: true })
})

const seedCurrentCycle = async () => {
  await Effect.runPromise(appendTransitionEpisode("ada", {
    type: "step-end", ts: "t", tick: 1, stepId: "s1", task: "burn to Kepler", goal: "arrive",
    verdict: "failed", transition: "replan", skill: "securing-fuel", wmDeltas: null,
  }))
  await Effect.runPromise(appendToolEpisode("ada", {
    ts: "t", tick: 1, stepId: "s1", tool: "bash", argsSummary: "{}", status: "error", durationMs: 1,
  }))
}

const deps = (skills: Parameters<typeof fsLayer>[0], errors: string[]) =>
  Layer.mergeAll(fsLayer(skills), logLayer(errors), NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)

describe("buildRetrospectPrompt", () => {
  it("embeds the skill index, aggregate, and sample, and demands evidence + JSON output", () => {
    const p = buildRetrospectPrompt({ index: "SKILL_INDEX", aggregate: "AGG_BLOCK", sample: "SAMPLE_BLOCK" })
    expect(p).toContain("SKILL_INDEX")
    expect(p).toContain("AGG_BLOCK")
    expect(p).toContain("SAMPLE_BLOCK")
    expect(p).toContain("evidence")
    expect(p).toContain("proposals")
  })
})

describe("retrospect.execute", () => {
  it("does NOT run a turn when the cycle produced no episodes", async () => {
    const errors: string[] = []
    const out = await Effect.runPromise(
      retrospect.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
        .pipe(Effect.provide(deps([], errors))) as Effect.Effect<{ proposals: number }, never, never>,
    )
    expect(out.proposals).toBe(0)
    expect(runTurnMock).not.toHaveBeenCalled()
  })

  it("grades the cycle and appends evidence-bearing proposals; drops evidence-less ones", async () => {
    await seedCurrentCycle()
    runTurnMock.mockImplementation(() =>
      Effect.succeed({
        output: JSON.stringify({
          proposals: [
            { action: "revise", skill: "securing-fuel", summary: "Top up earlier", body: "b", evidence: "step s1 failed; 1 tool error" },
            { action: "create", skill: "no-evidence", summary: "junk", evidence: "" }, // dropped
          ],
        }),
        timedOut: false, durationMs: 1,
      }),
    )
    const errors: string[] = []
    const out = await Effect.runPromise(
      retrospect.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
        .pipe(Effect.provide(deps([{ slug: "securing-fuel", name: "securing-fuel", description: "fuel", whenToUse: "low fuel" }], errors))) as Effect.Effect<{ proposals: number }, never, never>,
    )
    expect(out.proposals).toBe(1)
    expect(fs.existsSync(proposalsJsonlPath(char))).toBe(true)
    const stored = await Effect.runPromise(readProposals(char))
    expect(stored.map((p) => p.skill)).toEqual(["securing-fuel"])
    expect(stored[0].evidence.length).toBeGreaterThan(0)
  })

  it("a blank/timed-out turn appends nothing and never fails", async () => {
    await seedCurrentCycle()
    runTurnMock.mockImplementation(() => Effect.succeed({ output: "", timedOut: true, durationMs: 1 }))
    const errors: string[] = []
    const out = await Effect.runPromise(
      retrospect.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
        .pipe(Effect.provide(deps([], errors))) as Effect.Effect<{ proposals: number }, never, never>,
    )
    expect(out.proposals).toBe(0)
    expect(fs.existsSync(proposalsJsonlPath(char))).toBe(false)
    expect(errors.some((m) => /retrospect/i.test(m))).toBe(true)
  })

  it("a thrown turn is caught (never-fail) and appends nothing", async () => {
    await seedCurrentCycle()
    runTurnMock.mockImplementation(() => Effect.fail(new Error("turn boom")))
    const errors: string[] = []
    const out = await Effect.runPromise(
      retrospect.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
        .pipe(Effect.provide(deps([], errors))) as Effect.Effect<{ proposals: number }, never, never>,
    )
    expect(out.proposals).toBe(0)
    expect(errors.some((m) => /retrospect/i.test(m))).toBe(true)
  })
})
```

- [ ] **Step 3: Run it, expect failure**

```
pnpm vitest run packages/core/src/core/limbic/hippocampus/retrospect.test.ts
```

Expected: `Failed to resolve import "./retrospect.js"`.

- [ ] **Step 4: Implement**

Create `packages/core/src/core/limbic/hippocampus/retrospect.ts`:

```ts
/**
 * Meso retrospect stage (agent-cognition Stage 4, spec §4).
 *
 * Per reflection cycle, AFTER promote and BEFORE consolidate (see
 * planned-action.ts): grade the just-ended cycle's episode streams (§1) against
 * the character's skill index (§3) and APPEND skill create/revise/retire
 * proposals to me/growth/proposals.jsonl. Meso PROPOSES ONLY — it never edits a
 * skill file, never touches an identity file, never mutates the episode streams.
 * Proposals accumulate (deduped/capped) until the macro cycle (Stage 5)
 * adjudicates them.
 *
 * House reflection-turn pattern (like dream/consolidate): role:"brain", noTools,
 * runTurn via the claude binary, the shared REFLECTION_TURN_TIMEOUT_MS budget,
 * and a blank/timed-out/errored turn keeps NOTHING (never-fail). The large
 * episode input is bounded IN CODE (compact aggregates + a small raw sample)
 * before it reaches the model — the retrospect turn never sees the raw
 * prompt/output blobs the transition stream carries.
 */
import { Effect } from "effect"
import type { CommandExecutor } from "@effect/platform"
import { CharacterFs, type CharacterConfig } from "../../../services/CharacterFs.js"
import { CharacterLog, logError } from "../../../logging/log-writer.js"
import { OAuthToken } from "../../../services/OAuthToken.js"
import { renderSkillIndex } from "../../../services/skills-core.js"
import { readCurrentCycleEpisodes } from "../../../logging/episodes.js"
import { runTurn } from "../hypothalamus/process-runner.js"
import type { ModelConfig } from "../../model-config.js"
import { resolveModel } from "../../model-config.js"
import { REFLECTION_TURN_TIMEOUT_MS } from "./dream.js"
import {
  aggregateEpisodes,
  renderAggregate,
  renderRawSample,
  parseProposals,
  appendProposals,
} from "../../../conscious/growth-store.js"

/** How many of the cycle's most recent step-end records to sample raw. */
export const RETROSPECT_RAW_SAMPLE_STEPS = 12

export interface RetrospectInput {
  char: CharacterConfig
  containerId: string
  playerName: string
  addDirs?: string[]
  env?: Record<string, string>
  models: ModelConfig
}

export interface RetrospectOutput {
  proposals: number
}

/**
 * The retrospect turn prompt — character-facing, second person, reflective, with
 * a strict JSON output contract the harness parses. `index` is the bodiless
 * skill index; `aggregate` is the compact per-skill digest; `sample` is the
 * bounded raw step sample. All three are computed in code (prompt-budget).
 */
export function buildRetrospectPrompt(parts: { index: string; aggregate: string; sample: string }): string {
  return [
    "You have just finished a stretch of work and are looking back on it before you rest.",
    "This is your retrospect: a quiet moment to ask whether your *skills* — the notes-to-self",
    "you keep in me/skills/ — still serve you, and to propose changes for a stronger version",
    "of you to weigh later. You are not changing anything now. You are only proposing.",
    "",
    "## Your skills right now",
    "",
    parts.index,
    "",
    "## How the cycle went (measured from your own episode log)",
    "",
    parts.aggregate,
    "",
    "## A sample of your most recent steps",
    "",
    parts.sample,
    "",
    "## What to do",
    "",
    "Look for skills that are earning their place and skills that are not, and for work you",
    "did well or badly that no skill yet captures. Then propose concrete changes:",
    "",
    "- **create** — a new skill for a recurring kind of work you had no skill for.",
    "- **revise** — a sharper body for an existing skill that let you down or could be better.",
    "- **retire** — drop a skill you never reach for or that keeps steering you wrong.",
    "",
    "Rules:",
    "",
    "- Ground EVERY proposal in what actually happened this cycle. Cite the evidence: the",
    "  step ids, the verdicts, the tool-failure counts, the per-skill numbers above. A",
    "  proposal with no concrete evidence will be thrown away.",
    "- Propose only what the evidence clearly supports. If nothing is worth changing, return",
    "  an empty list. Do not invent work.",
    "- At most a handful of proposals. Quality over volume.",
    "- For create/revise, write the full proposed skill body (frontmatter is not needed here —",
    "  just the body prose). For retire, no body.",
    "",
    "## Output",
    "",
    "Respond with ONE JSON object and nothing else:",
    "",
    "```json",
    '{"proposals": [',
    '  {"action": "create|revise|retire", "skill": "<skill name>", "summary": "<one line: what and why>", "body": "<proposed body for create/revise; omit for retire>", "evidence": "<concrete citation: step ids / verdicts / tool stats>"}',
    "]}",
    "```",
  ].join("\n")
}

/** A turn produced no usable content if it timed out or returned only whitespace. */
const isBlankTurn = (r: { output: string; timedOut: boolean }): boolean =>
  r.timedOut || r.output.trim().length === 0

export const retrospect = {
  name: "retrospect" as const,
  execute: (
    input: RetrospectInput,
  ): Effect.Effect<
    RetrospectOutput,
    never,
    CharacterFs | CharacterLog | CommandExecutor.CommandExecutor | OAuthToken
  > =>
    Effect.gen(function* () {
      const charFs = yield* CharacterFs

      // 1. Read the just-ended cycle's episode streams (before rotation).
      const { tool, transition } = yield* readCurrentCycleEpisodes(input.char.name)
      // Empty cycle → nothing to grade; skip the turn entirely (no wasted turn,
      // and preserves callers that never set the episode root).
      if (tool.length === 0 && transition.length === 0) {
        return { proposals: 0 }
      }

      // 2. The bodiless skill index the turn grades against (never-fail read).
      const skills = yield* charFs.listSkills(input.char).pipe(Effect.catchAll(() => Effect.succeed([])))
      const index = renderSkillIndex(skills)

      // 3. Bound the prompt IN CODE: compact aggregates + a small raw sample.
      const aggregate = renderAggregate(aggregateEpisodes(tool, transition))
      const sample = renderRawSample(transition, RETROSPECT_RAW_SAMPLE_STEPS)
      const prompt = buildRetrospectPrompt({ index, aggregate, sample })

      // 4. One brain turn (house reflection pattern). A blank/timed-out/errored
      //    turn keeps NOTHING — never-fail, like dream/consolidate.
      const model = resolveModel(input.models, "retrospect", "smart")
      const turn = yield* runTurn({
        containerId: input.containerId,
        playerName: input.playerName,
        char: input.char,
        prompt,
        systemPrompt: "",
        model,
        timeoutMs: REFLECTION_TURN_TIMEOUT_MS,
        role: "brain",
        noTools: true,
        addDirs: input.addDirs,
        env: input.env,
      }).pipe(
        Effect.map((r) =>
          isBlankTurn(r)
            ? { ok: false as const, reason: r.timedOut ? "turn timed out (no output)" : "turn returned empty output" }
            : { ok: true as const, text: r.output },
        ),
        Effect.catchAll((e) => Effect.succeed({ ok: false as const, reason: String(e) })),
      )

      if (!turn.ok) {
        yield* logError(input.char.name, "hippocampus", `retrospect_failed: ${turn.reason} — no proposals this cycle`)
        return { proposals: 0 }
      }

      // 5. Parse (evidence-required, capped) + append (dedup, total cap). Proposes only.
      const parsed = parseProposals(turn.text, new Date().toISOString())
      const appended = yield* appendProposals(input.char, parsed)
      return { proposals: appended }
    }),
}
```

- [ ] **Step 5: Run it, expect pass; typecheck + commit**

```
pnpm vitest run packages/core/src/core/limbic/hippocampus/retrospect.test.ts
pnpm nx run-many -t typecheck --skip-nx-cache
git add packages/core/src/core/limbic/hippocampus/retrospect.ts packages/core/src/core/limbic/hippocampus/retrospect.test.ts packages/core/src/core/model-config.ts
git commit --no-verify -m "feat(retrospect): meso stage — bounded brain turn, evidence-bearing proposals

The per-cycle retrospect reads the just-ended cycle's episode streams + the
skill index, bounds the prompt in code (compact per-skill aggregates + a small
raw step sample), runs one role:brain noTools turn, parses evidence-required
proposals, and appends them to me/growth/proposals.jsonl. Proposes only;
never-fail (blank/timeout/error keeps nothing). Adds the 'retrospect' model role.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: wire the retrospect into `runReflection` (after promote, before consolidate)

Insert the stage at its spec-bound seam, wrapped in the same best-effort `Effect.catchAll(logError)` discipline as promote/consolidate/dream, with a `logBehavior` start/done pair.

**Files:**
- Modify: `packages/core/src/logging/behavior.ts:33` (reflection `stage` union gains `"retrospect"`)
- Modify: `packages/core/src/core/orchestrator/planned-action.ts` (import + the new stage block between promote `:81` and consolidate `:83`)
- Modify: `packages/core/src/core/orchestrator/planned-action.test.ts`

**Interfaces:**
- Consumes: `retrospect` (Task 3); `logBehavior`/`logError`/`logToConsole` (already imported, `planned-action.ts:10`); the layers `runReflection` already runs under (`CharacterFs`, `CommandExecutor`, `OAuthToken`, `CharacterLog` — the same set `dream`/`consolidate` require).
- Produces: no new exported signature. `runReflection`'s requirement channel is unchanged (retrospect requires only what dream/consolidate already require).

- [ ] **Step 1: Extend the reflection behavior stage union**

In `packages/core/src/logging/behavior.ts`, line 33, add `"retrospect"`:

```ts
  | { type: "reflection"; stage: "consolidate" | "dream" | "promote" | "retrospect"; status: "start" | "done"; counts?: Record<string, number> }
```

- [ ] **Step 2: Write the failing tests**

In `packages/core/src/core/orchestrator/planned-action.test.ts`, add `import { setEpisodeLogRoot, appendToolEpisode, appendTransitionEpisode } from "../../logging/episodes.js"` (extend the existing `episodes.js` import) and `import { readProposals } from "../../conscious/growth-store.js"`, then append a new describe. It sets an episode root, seeds the current cycle, and scripts `runTurnMock` so **call 1 is the retrospect** (retrospect now runs before consolidate):

```ts
describe("runReflection — meso retrospect (Stage 4)", () => {
  it("runs the retrospect AFTER promote and appends evidence-bearing proposals", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "reflect-retro-"))
    setEpisodeLogRoot(root)
    const charT = { name: "ada", dir: path.join(root, "players", "ada", "me") }
    try {
      // Current cycle: one failed step worn with a skill, one tool error.
      await Effect.runPromise(appendTransitionEpisode("ada", {
        type: "step-end", ts: "t", tick: 1, stepId: "s1", task: "burn", goal: "arrive",
        verdict: "failed", transition: "replan", skill: "securing-fuel", wmDeltas: null,
      }))
      await Effect.runPromise(appendToolEpisode("ada", {
        ts: "t", tick: 1, stepId: "s1", tool: "bash", argsSummary: "{}", status: "error", durationMs: 1,
      }))

      const fsFake = makeFs({ diary: lines(3, "d"), secrets: lines(4, "s") })
      // Call 1 = RETROSPECT (returns proposals); 2 = consolidate; 3 = dream diary; 4 = dream secrets.
      let call = 0
      runTurnMock.mockImplementation(() => {
        call++
        if (call === 1) {
          return Effect.succeed({
            output: JSON.stringify({ proposals: [
              { action: "revise", skill: "securing-fuel", summary: "top up earlier", body: "b", evidence: "step s1 failed; 1 tool error" },
            ] }),
            timedOut: false, durationMs: 1,
          })
        }
        return Effect.succeed({ output: lines(2, `t${call}`), timedOut: false, durationMs: 1 })
      })

      await run(
        runReflection(charT, "c1", DEFAULT_MODEL_CONFIG).pipe(
          Effect.provide(Layer.mergeAll(fsFake.layer, makeStore().layer, fakeLog, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)),
        ) as Effect.Effect<unknown, unknown, never>,
      )

      const stored = await Effect.runPromise(readProposals(charT))
      expect(stored.map((p) => p.skill)).toEqual(["securing-fuel"])
      // consolidate + dream still ran (calls 2..4).
      expect(call).toBe(4)
    } finally {
      setEpisodeLogRoot(null)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("a retrospect turn failure logs a STRUCTURED error and does NOT disturb consolidate/dream", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "reflect-retro-fail-"))
    setEpisodeLogRoot(root)
    const charT = { name: "ada", dir: path.join(root, "players", "ada", "me") }
    const errors: string[] = []
    const recordingLog = Layer.succeed(
      CharacterLog,
      CharacterLog.of({ emit: (_c, e) => Effect.sync(() => { if (e.kind === "error") errors.push(e.message) }) }),
    )
    try {
      await Effect.runPromise(appendTransitionEpisode("ada", {
        type: "step-end", ts: "t", tick: 1, stepId: "s1", task: "burn", goal: "arrive",
        verdict: "failed", transition: "replan", skill: null, wmDeltas: null,
      }))
      const fsFake = makeFs({ diary: lines(3, "d"), secrets: lines(4, "s") })
      // Call 1 = retrospect TIMES OUT (empty); 2 = consolidate; 3,4 = dream.
      let call = 0
      runTurnMock.mockImplementation(() => {
        call++
        if (call === 1) return Effect.succeed({ output: "", timedOut: true, durationMs: 1 })
        return Effect.succeed({ output: lines(2, `t${call}`), timedOut: false, durationMs: 1 })
      })

      await run(
        runReflection(charT, "c1", DEFAULT_MODEL_CONFIG).pipe(
          Effect.provide(Layer.mergeAll(fsFake.layer, makeStore().layer, recordingLog, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)),
        ) as Effect.Effect<unknown, unknown, never>,
      )

      expect(errors.some((m) => /retrospect/i.test(m))).toBe(true)
      // consolidate + dream still ran after the retrospect failure (best-effort).
      expect(fsFake.secretsWrites.length).toBeGreaterThanOrEqual(1)
      expect(call).toBe(4)
    } finally {
      setEpisodeLogRoot(null)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
```

Note: the pre-existing `runReflection` tests run with `episodeRoot` unset (the reader returns empty, so the retrospect skips its turn and adds no `runTurn` call), so their `call` sequencing is unchanged. The existing "episode cycle rotation" test seeds only a tool episode with no proposals-shaped output — its all-`"x"` mock tolerates the extra retrospect call and it asserts no call count.

- [ ] **Step 3: Run them, expect failure**

```
pnpm vitest run packages/core/src/core/orchestrator/planned-action.test.ts -t "meso retrospect"
```

Expected: the proposals are never written (no retrospect stage exists yet), so `readProposals` returns `[]` and the first assertion fails.

- [ ] **Step 4: Implement**

In `packages/core/src/core/orchestrator/planned-action.ts`, add the import near the other hippocampus imports (after `:8`):

```ts
import { retrospect } from "../limbic/hippocampus/retrospect.js"
```

Then insert the retrospect stage between the promote block (ends `:81`) and the consolidate block (starts `:83`):

```ts
    // Meso retrospect (spec §4): grade the just-ended cycle's episode streams
    // against the skill index and APPEND skill create/revise/retire proposals to
    // me/growth/proposals.jsonl. Placed AFTER promote (spec:110, "so nothing is
    // lost to the cull") and BEFORE consolidate: promote + retrospect both
    // HARVEST the just-ended cycle's raw substrate (raw diary appends / raw
    // episode streams) before the destructive memory rewrites, and this runs
    // BEFORE finishEpisodeCycle rotates the streams at the end. PROPOSES ONLY —
    // never edits a skill or identity file. Best-effort/never-fail, same
    // discipline as every other stage: a retrospect failure must not disturb
    // consolidate/dream.
    yield* logBehavior(char.name, "hippocampus", "reflection", { type: "reflection", stage: "retrospect", status: "start" })
    yield* retrospect
      .execute({ char, containerId, playerName: char.name, addDirs, env, models })
      .pipe(
        Effect.flatMap((r) =>
          logBehavior(char.name, "hippocampus", "reflection", {
            type: "reflection",
            stage: "retrospect",
            status: "done",
            counts: { proposals: r.proposals },
          }),
        ),
        Effect.catchAll((e) =>
          logError(char.name, "hippocampus", `Retrospect failed: ${e}`).pipe(Effect.catchAll(() => Effect.void)),
        ),
      )
```

- [ ] **Step 5: Run the full suite, typecheck + commit**

```
pnpm vitest run packages/core/src/core/orchestrator/planned-action.test.ts packages/core/src/core/limbic/hippocampus/retrospect.test.ts packages/core/src/conscious/growth-store.test.ts packages/core/src/logging/episodes.test.ts
pnpm nx run-many -t typecheck --skip-nx-cache
git add packages/core/src/core/orchestrator/planned-action.ts packages/core/src/core/orchestrator/planned-action.test.ts packages/core/src/logging/behavior.ts
git commit --no-verify -m "feat(retrospect): wire the meso stage into runReflection after promote

runReflection now runs the retrospect between promote and consolidate: it grades
the just-ended cycle and appends skill proposals to me/growth/proposals.jsonl,
before finishEpisodeCycle rotates the streams. Wrapped in the same best-effort
catchAll as the other stages (a retrospect failure never disturbs
consolidate/dream), with a reflection behavior start/done pair (new 'retrospect'
stage).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-review checklist

- [ ] **Spec §4-meso coverage.** New retrospect stage in `runReflection` after promote (Task 4) ✓; reads the just-ended cycle's episode streams + the skill index (Tasks 2, 3) ✓; APPENDS create/revise/retire proposals to `me/growth/proposals.jsonl` (Task 1) ✓; each proposal cites episode evidence, and evidence-less proposals are rejected at parse (Task 1 `parseProposals`, tested) ✓; proposes only — no skill/identity writes (Global Constraints; `retrospect.execute` calls only `appendProposals`) ✓; a retrospect failure never disturbs promote/consolidate/dream (never-fail turn handling + `Effect.catchAll` at the call site, tested in Task 4) ✓; proposals accumulate deduped/capped until macro (Task 1 `appendProposals` + `MAX_*` caps) ✓; SpaceMolt only ✓.
- [ ] **Runs BEFORE finishEpisodeCycle's rotation.** Placement is after promote / before consolidate; `finishEpisodeCycle` is the last statement of `runReflection` (`planned-action.ts:131`); `readCurrentCycleEpisodes` reads the tail past the previous boundary — verified by Task 2's "reads only the current cycle" test and Task 4's placement.
- [ ] **Stage 5 (macro) interface defined.** `readProposals(char): Effect<SkillProposal[]>`, the `SkillProposal` record type, and `proposalsJsonlPath(char)` are the exact read surface + record shape the macro adjudicator consumes (Task 1 Interfaces).
- [ ] **Design questions resolved with justification.** growth-store vs CharacterFs (decision 1); placement (decision 2); read scope (decision 3); hybrid code-side aggregation + bounded raw sample (decision 4, Global Constraints "Bounded prompt"); tolerant self-contained proposal extraction + dedup/per-cycle/total caps (decision 5, Task 1).
- [ ] **Placeholder scan.** No `TODO`, `...`, `<placeholder>`, or elided code — every step carries complete code including the full retrospect prompt text.
- [ ] **Type consistency.** `SkillProposal.action` ⊆ `ProposalAction`; `verdicts: Record<Judgment, number>` matches `Judgment = "succeeded" | "partially_succeeded" | "failed"` (`skills/types.ts:98`); episode record fields match `ToolEpisode`/`StepBoundaryEpisode` (`episodes.ts:28-38,56-69`); `runTurn` config matches the `dream`/`consolidate` call shape; `logBehavior` stage `"retrospect"` is added to the union it type-checks against (Task 4 Step 1); `resolveModel(models, "retrospect", "smart")` uses the `Role` extended in Task 3.
- [ ] **Never-fail discipline.** Every new reader/writer in `growth-store.ts` and `episodes.ts` is `Effect<..., never, never>`; `retrospect.execute`'s error channel is `never` (turn errors caught, `listSkills` caught); the call site adds a belt-and-suspenders `Effect.catchAll(logError)`.
- [ ] **No wasted turn / test-sequencing preserved.** `retrospect.execute` skips the turn on an empty cycle, so the pre-existing `planned-action.test.ts` tests (episode root unset) see no extra `runTurn` call.

## Global commands reference

```
# per task, from the worktree root:
pnpm vitest run <relative-test-path>
pnpm nx run-many -t typecheck --skip-nx-cache
git commit --no-verify -m "<conventional message + Co-Authored-By trailer>"
```
