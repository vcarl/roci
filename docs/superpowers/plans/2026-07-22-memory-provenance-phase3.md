# Memory Provenance & Salience — Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Join Phase 1 (provenance trust-tier, shipped) and Phase 2 (character salience profile, shipped) into **salience-modulated decay ranking** — capture the per-event `weight`/`drive` the hindbrain already computes as a per-memory dimensional signature (`dims`), and let each character's salience profile set how fast each memory decays, so a salient memory outlives a trivial one at equal relevance as they age.

**Architecture:** A new nullable `dims TEXT` column stores each memory's `{drive: weight/5}` signature (JSON), captured in the `observeMemories` extractor and threaded through the generated in-container `memory` CLI exactly as Phase 1 threaded `provenance`. At recall, the gateway loads the character's parsed salience profile (`CharacterFs.readSalience` → `parseSalience`, Phase 2) and feeds it, with `now`, into a pure `rerank(hits, k, nowMs, salience)`. Ranking becomes `relevance × reputationWeight(provenance) × recency(age, halfLife(salienceWeight(hit, salience)))`: salience enters **only as the decay-rate knob** — fresh trivial and fresh salient memories rank equally; the difference is staying power. Decay knobs live at one commented site in `memory-rank.ts`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Effect-TS (`Context`/`Layer`, `Clock`, `@effect/platform` `FileSystem` via `CharacterFsLive`), vitest, sqlite-vec via `bun:sqlite` (generated CLI), Docker exec.

**Scope note — this is Phase 3 of 3** (see `docs/superpowers/specs/2026-07-21-memory-provenance-salience-design.md` §7). Phase 3 **consumes** Phase 1 (provenance rerank, `MemoryHit.provenance`, `MIGRATION_COLUMNS`, the generated-CLI threading pattern) and Phase 2 (`CharacterFs.readSalience`, `parseSalience`, `TEMPLATE_SALIENCE`) — **do not reimplement either**. Both are already **merged to `main`** (2026-07-22, @ `feb92a0`); verify by reading, then build on top.

## Global Constraints

- **Base branch:** a fresh branch off `main` (Phase 1 & Phase 2 are merged to `main` @ `feb92a0`; this plan builds Phase 3 on top). Work in the worktree `/Users/vcarl/workspace/roci/.claude/worktrees/memory-provenance`. Paths below are relative to that worktree root.
- **Memory module dir:** `packages/core/src/brain/limbic/hippocampus/memory/` (abbreviated `MEM/`).
- **ESM imports:** every relative import specifier ends in `.js`. Effect-TS service/layer patterns as in the surrounding code.
- **Phase 3 CONSUMES, never reimplements:** Phase 2 `parseSalience`/`readSalience`/`TEMPLATE_SALIENCE` (in `core/salience.ts` + `services/CharacterFs.ts`) and Phase 1 provenance rerank (`memory-rank.ts` `reputationWeight`/`compositeScore`/`rerank`, `memory-provenance.ts`).
- **`dims` column (exact):** `dims TEXT` — **nullable, no default** (legacy rows → NULL → neutral salience). Stored as a JSON string; the NDJSON contract emits it as a parsed object (or `null`).
- **observe signature capture (exact):** in `observeMemories`, `dims = observe.drive ? { [observe.drive]: observe.weight / 5 } : {}`. No clamping in the gateway (the skill clamps `weight` to 0–5 upstream).
- **Decay knobs at ONE site in `MEM/memory-rank.ts`, commented experimentally-tunable, ms units (exact first guesses):** `HALF_LIFE_MIN = 3_600_000` (1 h), `HALF_LIFE_MAX = 2_592_000_000` (30 d), `NEUTRAL_SALIENCE = 0.4`.
- **salienceWeight (exact — the character's caring MUST affect the result):** `dims` empty/absent → `NEUTRAL_SALIENCE`; else `Σ_d dims[d] × salience[d]` over `d ∈ keys(dims)` that are present + finite in the profile, clamped to `[0,1]`; if NO dim of the memory is present in the profile (e.g. a domain-drive memory under a core-only template fallback) → `NEUTRAL_SALIENCE`. For v1 single-drive dims this is exactly `salience[drive] × (weight/5)`. **Do NOT divide by `Σ salience[d]`** — that normalization cancels the character's salience for single-drive memories (all of v1), making Phase 2's profile inert. See the *Resolved ambiguity* note below.
- **halfLife / recency (exact):** `halfLife(s) = HALF_LIFE_MIN × (HALF_LIFE_MAX / HALF_LIFE_MIN) ** s`; `recency(ageMs, s) = 0.5 ** (ageMs / halfLife(s))`, returning `1` when `ageMs` is non-finite or `≤ 0` (fresh/future/unknown age never decays).
- **composite (exact):** `relevance × reputationWeight(provenance) × recency(nowMs − Date.parse(hit.ts), salienceWeight(hit, salience))`, NaN-safe on `score`.
- **Migration is idempotent:** append `{ name: "dims", ddl: "ALTER TABLE memories ADD COLUMN dims TEXT" }` to `MIGRATION_COLUMNS`; the CLI's PRAGMA-guarded loop already applies it once. Legacy rows get NULL dims → neutral salience. **No backfill.**
- **Injection stays as Phase 1 left it:** `formatRecall` already annotates `(provenance · age)`; salience stays **implicit in ordering**. Do NOT rewrite the `"You recall"`/`"Relevant memories"` labels, add prompt-instruction prose, or touch `macro.ts` / the `{{synthesis}}` surface / `skills/*.md`.
- **Test command (single file):** `pnpm vitest --run <path>` (from the worktree root). **Package suite:** `pnpm vitest --run packages/core/src/brain/limbic/hippocampus/memory`. **Typecheck (no cache):** `pnpm nx run @roci/core:typecheck --skip-nx-cache`.
- **Every commit is green:** each task ends with its own tests passing AND `@roci/core` typechecking (tests included). The pre-commit hook runs a full nx build; do NOT use `--no-verify`.
- **Commits:** conventional-commit style; end the body with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## Resolved ambiguity — the `salienceWeight` formula (READ BEFORE Task 1)

The spec (§3) is internally inconsistent about `salienceWeight`. Its **boxed formula** is `Σ_d dims[d]×salience[d] / Σ_d salience[d]`, but its **prose** says this "reduces to the interpretable `salience[drive] × (weight/5)` — how much the character cares × how hard the event hit it." Those disagree: for a single-drive memory the boxed denominator **cancels `salience[drive]`**, leaving just `weight/5` — so the character's salience profile would have **zero effect** on ranking. Since every v1 memory is single-drive (`dims` come only from `observe.drive`), the boxed formula makes Phase 2's entire character-salience profile **inert**.

This plan implements the **prose intent**: the unnormalized dot product `Σ_d dims[d] × salience[d]` (clamped to [0,1]), which for single-drive dims is exactly `salience[drive] × (weight/5)`. A memory whose dims are all absent from the profile falls back to `NEUTRAL_SALIENCE`. This is a deliberate correction of the spec's boxed formula — do NOT "fix" it back to the normalized version during review. (The spec doc on `main` should be patched to match; tracked as a follow-up.)

---

## File Structure

**Modified files**
- `MEM/longterm-store.ts` — add `MemoryHit.dims?`; add `dims?` to the `LongtermStore.remember` entry type; emit `--dims` in the Live impl. (Tasks 1 & 4)
- `MEM/memory-rank.ts` — `HALF_LIFE_MIN`/`HALF_LIFE_MAX`/`NEUTRAL_SALIENCE`, `salienceWeight`, `halfLife`, `recency`; extend `compositeScore` + `rerank` signatures. (Task 1)
- `MEM/memory-rank.test.ts` — rewrite to new signatures + salience-decay cases. (Task 1)
- `MEM/memory-gateway.ts` — pass `now`+`salience` to `rerank` (Task 1 placeholder → Task 5 real profile); `MemoryWrite.dims?`; `observeMemories` captures dims; `recall` loads the profile via `CharacterFs`; `MemoryGatewayLive` gains a `CharacterFs` requirement + parsed-profile cache. (Tasks 1 & 5)
- `MEM/memory-gateway.test.ts` — observe-dims expectation; `CharacterFs` fake in the run harness. (Task 5)
- `MEM/memory-sql.ts` — `dims` in schema/insert/knn SQL. (Task 2)
- `MEM/memory-sql.test.ts` — 3 new SQL-shape assertions. (Task 2)
- `MEM/memory-provenance.ts` — add the `dims` migration column. (Task 2)
- `MEM/memory-provenance.test.ts` — assert the dims migration entry. (Task 2)
- `MEM/memory-cli.ts` — parse/bind/emit `dims` in the generated bun script. (Task 3)
- `MEM/memory-cli.test.ts` — assert the script embeds dims store/emit. (Task 3)
- `MEM/memory-format.ts` — carry `dims` through `MemoryRow` + `formatResults` (parity). (Task 3)
- `MEM/memory-format.test.ts` — assert dims round-trips. (Task 3)
- `MEM/longterm-store.test.ts` — `--dims` command-construction assertion. (Task 4)
- `apps/roci/src/cli.ts` — wire `CharacterFsLive` into the `MemoryGatewayLive` branch. (Task 5)

**Task order (each commit green):**
1. **Task 1 — ranking (pure + call-site keep-alive).** `memory-rank.ts` salience-decay functions + extended `compositeScore`/`rerank`; add `MemoryHit.dims?` (a type field only, read by `salienceWeight`); update the single `rerank` call in `memory-gateway.ts` to pass `now` + a neutral `{}` placeholder so it compiles. No I/O, no CharacterFs.
2. **Task 2 — SQL column + migration.** `memory-sql.ts` + `memory-provenance.ts`.
3. **Task 3 — generated CLI store/emit + NDJSON parity.** `memory-cli.ts` + `memory-format.ts`.
4. **Task 4 — store seam write path.** `LongtermStore.remember` gains `dims?`; Live impl emits `--dims`.
5. **Task 5 — gateway wiring.** `MemoryWrite.dims?`; `observeMemories` capture; `recall` loads the real parsed profile (`CharacterFs` dep + cache); replace Task 1's `{}` placeholder; fix the gateway test harness + production wiring.
6. **Task 6 — integration verification.**

Task 1 leads because `salienceWeight` reads `MemoryHit.dims` and the `rerank`/`compositeScore` signature change must land with its only call site (the gateway) in the same commit; the neutral `{}` placeholder keeps every downstream green until Task 5 supplies the character profile. The write path (2→4) is independent of ranking. Task 5 is last because it depends on the `dims` write path (Tasks 2-4) reaching the store and on Phase 2's `readSalience`/`parseSalience`.

---

### Task 1: Salience-decay ranking (pure functions + extended rerank)

Lands the ranking math as one green commit: `MemoryHit.dims?` (read by `salienceWeight`), the new pure functions, the extended `compositeScore`/`rerank` signatures, and the single gateway call site that must move with them. The gateway passes a neutral `{}` salience placeholder here — Task 5 swaps in the real profile.

**Files:**
- Modify: `packages/core/src/brain/limbic/hippocampus/memory/longterm-store.ts` (`MemoryHit` interface ~64-73)
- Modify: `packages/core/src/brain/limbic/hippocampus/memory/memory-rank.ts`
- Modify: `packages/core/src/brain/limbic/hippocampus/memory/memory-rank.test.ts` (rewrite)
- Modify: `packages/core/src/brain/limbic/hippocampus/memory/memory-gateway.ts` (`recall` ~158-169)

**Interfaces:**
- Consumes: `Provenance` + `reputationWeight`/`REPUTATION_WEIGHT`/`RERANK_OVERFETCH` (Phase 1); `MemoryHit` (extended here).
- Produces:
  - `MemoryHit` gains `readonly dims?: Record<string, number>` (parsed from NDJSON; absent for legacy/non-observe rows).
  - `memory-rank.ts`: `const HALF_LIFE_MIN = 3_600_000`, `const HALF_LIFE_MAX = 2_592_000_000`, `const NEUTRAL_SALIENCE = 0.4`, `function salienceWeight(hit: MemoryHit, salience: Record<string, number>): number`, `function halfLife(s: number): number`, `function recency(ageMs: number, s: number): number`, `function compositeScore(hit: MemoryHit, nowMs: number, salience: Record<string, number>): number`, `function rerank(hits: ReadonlyArray<MemoryHit>, k: number, nowMs: number, salience: Record<string, number>): MemoryHit[]`.
  - `memory-gateway.ts`: the `rerank` call becomes `rerank(hits, opts.k, now, salience)` where `salience` is a neutral `{}` placeholder (Task 5 replaces it).

- [ ] **Step 1: Add the `dims` field to `MemoryHit`**

In `longterm-store.ts`, replace the `MemoryHit` interface:

```ts
/** A ranked recall hit — one NDJSON line from the in-container `memory search`. */
export interface MemoryHit {
  readonly id: number
  readonly ts: string
  readonly source: string
  /** Objective trust-tier derived from `source` at write time (see memory-provenance). */
  readonly provenance: Provenance
  readonly tags: ReadonlyArray<string>
  readonly text: string
  readonly score: number
}
```

with:

```ts
/** A ranked recall hit — one NDJSON line from the in-container `memory search`. */
export interface MemoryHit {
  readonly id: number
  readonly ts: string
  readonly source: string
  /** Objective trust-tier derived from `source` at write time (see memory-provenance). */
  readonly provenance: Provenance
  readonly tags: ReadonlyArray<string>
  readonly text: string
  readonly score: number
  /**
   * Per-memory salience signature `{ drive: weight/5 }`, captured at write time
   * from the hindbrain observe signal (Phase 3 §3). Absent/NULL for legacy rows
   * and non-observe writes → neutral salience at recall. Parsed from NDJSON.
   */
  readonly dims?: Record<string, number>
}
```

(Optional field → every existing `MemoryHit` literal in the codebase still typechecks unchanged.)

- [ ] **Step 2: Rewrite the failing test**

Replace the entire contents of `memory-rank.test.ts` with:

```ts
import { describe, it, expect } from "vitest"
import type { MemoryHit } from "./longterm-store.js"
import {
  RERANK_OVERFETCH,
  reputationWeight,
  compositeScore,
  rerank,
  salienceWeight,
  halfLife,
  recency,
  HALF_LIFE_MIN,
  HALF_LIFE_MAX,
  NEUTRAL_SALIENCE,
} from "./memory-rank.js"

const NOW = Date.parse("2026-07-22T00:00:00Z")

const hit = (over: Partial<MemoryHit>): MemoryHit => ({
  id: 1, ts: new Date(NOW).toISOString(), source: "orient",
  provenance: "inferred", tags: [], text: "t", score: 0.5, ...over,
})

describe("reputationWeight (Phase 1, unchanged)", () => {
  it("orders grounded > episodic > inferred > asserted", () => {
    expect(reputationWeight("grounded")).toBeGreaterThan(reputationWeight("episodic"))
    expect(reputationWeight("episodic")).toBeGreaterThan(reputationWeight("inferred"))
    expect(reputationWeight("inferred")).toBeGreaterThan(reputationWeight("asserted"))
  })
})

describe("salienceWeight", () => {
  it("empty dims → NEUTRAL_SALIENCE", () => {
    expect(salienceWeight(hit({ dims: {} }), { safety: 1 })).toBe(NEUTRAL_SALIENCE)
  })
  it("absent dims → NEUTRAL_SALIENCE", () => {
    expect(salienceWeight(hit({}), { safety: 1 })).toBe(NEUTRAL_SALIENCE)
  })
  it("single-drive dims = salience[drive] × (weight/5) — the character's caring matters", () => {
    // safety hit at 0.8 (=4/5); a character who cares 0.5 → 0.4
    expect(salienceWeight(hit({ dims: { safety: 0.8 } }), { safety: 0.5, agency: 0.3 })).toBeCloseTo(0.4, 6)
    // the SAME memory is more salient to a character who cares more (0.9 → 0.72)
    expect(salienceWeight(hit({ dims: { safety: 0.8 } }), { safety: 0.9 })).toBeCloseTo(0.72, 6)
  })
  it("a drive absent from the profile → unscored → NEUTRAL_SALIENCE", () => {
    expect(salienceWeight(hit({ dims: { mystery: 0.9 } }), { safety: 0.5 })).toBe(NEUTRAL_SALIENCE)
  })
  it("multi-drive dims sum caring×intensity, clamped to [0,1]", () => {
    // 1×1 + 0×1 = 1.0
    expect(salienceWeight(hit({ dims: { safety: 1, agency: 0 } }), { safety: 1, agency: 1 })).toBeCloseTo(1, 6)
    // 0.5×0.4 + 0.5×0.4 = 0.4
    expect(salienceWeight(hit({ dims: { safety: 0.5, agency: 0.5 } }), { safety: 0.4, agency: 0.4 })).toBeCloseTo(0.4, 6)
  })
})

describe("halfLife", () => {
  it("s=0 → HALF_LIFE_MIN, s=1 → HALF_LIFE_MAX", () => {
    expect(halfLife(0)).toBe(HALF_LIFE_MIN)
    expect(halfLife(1)).toBe(HALF_LIFE_MAX)
  })
  it("is monotonically increasing in s", () => {
    expect(halfLife(0)).toBeLessThan(halfLife(0.5))
    expect(halfLife(0.5)).toBeLessThan(halfLife(1))
  })
})

describe("recency", () => {
  it("is 0.5 at exactly one half-life", () => {
    expect(recency(halfLife(0.5), 0.5)).toBeCloseTo(0.5, 6)
    expect(recency(halfLife(0), 0)).toBeCloseTo(0.5, 6)
    expect(recency(halfLife(1), 1)).toBeCloseTo(0.5, 6)
  })
  it("returns 1 for fresh / future / unknown age", () => {
    expect(recency(0, 0.5)).toBe(1)
    expect(recency(-5_000, 0.5)).toBe(1)
    expect(recency(Number.NaN, 0.5)).toBe(1)
  })
})

describe("compositeScore", () => {
  it("at age 0 reduces to relevance × reputation (recency = 1)", () => {
    // grounded (1.0) × 0.4 × 1 = 0.4 ; asserted (0.45) × 0.4 × 1 = 0.18
    expect(compositeScore(hit({ provenance: "grounded", score: 0.4 }), NOW, {})).toBeCloseTo(0.4, 6)
    expect(compositeScore(hit({ provenance: "asserted", score: 0.4 }), NOW, {})).toBeCloseTo(0.18, 6)
  })
  it("guards a non-finite score to 0", () => {
    expect(compositeScore(hit({ provenance: "grounded", score: Number.NaN }), NOW, {})).toBe(0)
  })
})

describe("rerank", () => {
  it("a grounded hit outranks an asserted hit at equal relevance and age", () => {
    const grounded = hit({ id: 1, provenance: "grounded", score: 0.5 })
    const asserted = hit({ id: 2, provenance: "asserted", score: 0.5 })
    expect(rerank([asserted, grounded], 2, NOW, {}).map((h) => h.id)).toEqual([1, 2])
  })
  it("relevance still dominates a large trust gap at equal age", () => {
    const a = hit({ id: 1, provenance: "asserted", score: 0.95 }) // 0.4275
    const b = hit({ id: 2, provenance: "grounded", score: 0.3 })  // 0.30
    expect(rerank([b, a], 2, NOW, {}).map((h) => h.id)).toEqual([1, 2])
  })
  it("a salient memory outlives a trivial one at equal relevance as age grows", () => {
    const salience = { safety: 1.0 }
    const aged = new Date(NOW - 2 * 24 * 3600_000).toISOString() // 2 days old
    const salient = hit({ id: 1, provenance: "grounded", score: 0.5, ts: aged, dims: { safety: 1.0 } })
    const trivial = hit({ id: 2, provenance: "grounded", score: 0.5, ts: aged, dims: {} })
    // Fresh (age 0): equal composite → salience is decay-only, not a rank boost.
    expect(compositeScore(hit({ ...salient, ts: new Date(NOW).toISOString() }), NOW, salience))
      .toBeCloseTo(compositeScore(hit({ ...trivial, ts: new Date(NOW).toISOString() }), NOW, salience), 6)
    // Aged: the salient memory decays slower → ranks first.
    expect(rerank([trivial, salient], 2, NOW, salience).map((h) => h.id)).toEqual([1, 2])
  })
  it("truncates to k", () => {
    expect(rerank([hit({ id: 1 }), hit({ id: 2 }), hit({ id: 3 })], 2, NOW, {})).toHaveLength(2)
  })
  it("over-fetch factor is a positive integer > 1", () => {
    expect(Number.isInteger(RERANK_OVERFETCH)).toBe(true)
    expect(RERANK_OVERFETCH).toBeGreaterThan(1)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest --run packages/core/src/brain/limbic/hippocampus/memory/memory-rank.test.ts`
Expected: FAIL — `salienceWeight`/`halfLife`/`recency`/`HALF_LIFE_MIN`/… not exported; `compositeScore`/`rerank` called with the new arity.

- [ ] **Step 4: Extend `memory-rank.ts`**

Replace the entire contents of `memory-rank.ts` with:

```ts
/**
 * Host-side re-ranking for recall (design 2026-07-21 §4, Phases 1 & 3).
 *
 * sqlite-vec can only rank by distance, so `recall` over-fetches `k *
 * RERANK_OVERFETCH` nearest hits and this pure function re-orders them by
 *   relevance × reputationWeight(provenance) × recency(age, halfLife(salience))
 * then truncates to the caller's `k`. Relevance stays dominant (the other two
 * factors are bounded ≤ 1), so we down-weight low-trust / faded memories without
 * surfacing irrelevant ones.
 *
 * Salience enters ONLY as the decay-rate knob (Phase 3): a fresh trivial memory
 * and a fresh salient memory rank equally when fresh — the difference is staying
 * power as they age. `salienceWeight` maps a memory's dimensional signature
 * against the character's salience profile; `halfLife` geometrically interpolates
 * that into a decay half-life; `recency` is the exponential decay.
 */

import type { Provenance } from "./memory-provenance.js"
import type { MemoryHit } from "./longterm-store.js"

/** Ask the vec index for this many × the caller's k, then re-rank down to k. */
export const RERANK_OVERFETCH = 4

/** Multiplicative trust weight per provenance tier. */
export const REPUTATION_WEIGHT: Record<Provenance, number> = {
  grounded: 1.0,
  episodic: 0.85,
  inferred: 0.6,
  asserted: 0.45,
}

export function reputationWeight(p: Provenance): number {
  return REPUTATION_WEIGHT[p] ?? REPUTATION_WEIGHT.asserted
}

// ---- Decay knobs (Phase 3 §9) — EXPERIMENTALLY TUNABLE, all in MILLISECONDS. ----
// These are first-guesses; validate + retune via a roci QA run (does a salient
// memory persist and a trivial one fade at psychologically plausible rates?).
// This is the ONE site — do not scatter copies.
/** Half-life of a maximally-trivial memory (salienceWeight = 0): 1 hour. */
export const HALF_LIFE_MIN = 3_600_000
/** Half-life of a maximally-salient memory (salienceWeight = 1): 30 days. */
export const HALF_LIFE_MAX = 2_592_000_000
/** Salience assigned to a memory with no dimensional signature (legacy/non-observe). */
export const NEUTRAL_SALIENCE = 0.4

/**
 * How salient THIS memory is to THIS character: the character's caring × the
 * event's intensity, summed over the memory's dims (a dot product of the memory's
 * `dims` against the character's `salience` profile), clamped to [0,1]. The
 * character's profile MUST affect the result — that is the whole point of Phase 2.
 * Empty/absent dims → NEUTRAL_SALIENCE. A memory whose every dim is absent from
 * the profile (e.g. a domain-drive memory under a core-only template fallback)
 * can't be scored → NEUTRAL_SALIENCE (never NaN). For v1's single-drive observe
 * dims this is exactly `salience[drive] × (weight/5)`.
 *
 * NOTE: the spec §3 boxed formula divides by `Σ salience[d]`; that normalization
 * cancels salience for single-drive dims (see the plan's Resolved-ambiguity note)
 * and contradicts the spec's own prose. The dot product below is the intent.
 */
export function salienceWeight(hit: MemoryHit, salience: Record<string, number>): number {
  const dims = hit.dims
  if (!dims) return NEUTRAL_SALIENCE
  const keys = Object.keys(dims)
  if (keys.length === 0) return NEUTRAL_SALIENCE
  let sum = 0
  let scored = 0
  for (const d of keys) {
    const s = salience[d]
    if (typeof s !== "number" || !Number.isFinite(s)) continue
    sum += dims[d] * s
    scored += 1
  }
  if (scored === 0) return NEUTRAL_SALIENCE
  return Math.min(1, Math.max(0, sum))
}

/** Geometric interpolation MIN→MAX over salience s ∈ [0,1]. s=0→MIN, s=1→MAX. */
export function halfLife(s: number): number {
  return HALF_LIFE_MIN * (HALF_LIFE_MAX / HALF_LIFE_MIN) ** s
}

/** Exponential decay: 0.5 at one half-life. Fresh/future/unknown age → 1 (no decay). */
export function recency(ageMs: number, s: number): number {
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1
  return 0.5 ** (ageMs / halfLife(s))
}

/** relevance(score) × reputation × recency(age, salience-modulated half-life). NaN score → 0. */
export function compositeScore(hit: MemoryHit, nowMs: number, salience: Record<string, number>): number {
  const rel = Number.isFinite(hit.score) ? hit.score : 0
  const s = salienceWeight(hit, salience)
  const rec = recency(nowMs - Date.parse(hit.ts), s)
  return rel * reputationWeight(hit.provenance) * rec
}

/** Re-order by composite score (desc) and keep the top `k`. Pure; input untouched. */
export function rerank(
  hits: ReadonlyArray<MemoryHit>,
  k: number,
  nowMs: number,
  salience: Record<string, number>,
): MemoryHit[] {
  return hits
    .map((h) => ({ h, s: compositeScore(h, nowMs, salience) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, Math.max(0, k))
    .map((x) => x.h)
}
```

- [ ] **Step 5: Update the gateway `rerank` call site (neutral placeholder)**

In `memory-gateway.ts`, replace the `recall` implementation:

```ts
      recall: (containerId, char, query, opts) =>
        Effect.gen(function* () {
          const q = query.trim()
          if (!q) return ""
          // Over-fetch, then re-rank down to k by relevance × trust.
          const hits = yield* store
            .recall(containerId, char, q, { k: opts.k * RERANK_OVERFETCH, tags: opts.tags })
            .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<MemoryHit>)))
          const now = yield* Clock.currentTimeMillis
          const ranked = rerank(hits, opts.k)
          return formatRecall(ranked, opts.label, now, opts.maxChars)
        }),
```

with:

```ts
      recall: (containerId, char, query, opts) =>
        Effect.gen(function* () {
          const q = query.trim()
          if (!q) return ""
          // Over-fetch, then re-rank down to k by relevance × trust × salience-decay.
          const hits = yield* store
            .recall(containerId, char, q, { k: opts.k * RERANK_OVERFETCH, tags: opts.tags })
            .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<MemoryHit>)))
          const now = yield* Clock.currentTimeMillis
          // Phase 3 Task 5 replaces this neutral placeholder with the character's
          // parsed salience profile (CharacterFs.readSalience → parseSalience).
          const salience: Record<string, number> = {}
          const ranked = rerank(hits, opts.k, now, salience)
          return formatRecall(ranked, opts.label, now, opts.maxChars)
        }),
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest --run packages/core/src/brain/limbic/hippocampus/memory/memory-rank.test.ts packages/core/src/brain/limbic/hippocampus/memory/memory-gateway.test.ts`
Expected: PASS. (The existing gateway tests still pass — with an empty profile every hit takes NEUTRAL_SALIENCE and still surfaces; the assertions only check the block contains the recalled text and the over-fetch k.)

- [ ] **Step 7: Typecheck (tests included)**

Run: `pnpm nx run @roci/core:typecheck --skip-nx-cache`
Expected: SUCCESS. `MemoryHit.dims?` is optional, so `macro.ts` (reads `.source`/`.tags`/`.text`, never constructs a full `MemoryHit`) and every `MemoryHit` literal in tests still compile untouched. The only `rerank`/`compositeScore` caller is the gateway (updated here).

- [ ] **Step 8: Commit**

```bash
cd /Users/vcarl/workspace/roci/.claude/worktrees/memory-provenance
git add packages/core/src/brain/limbic/hippocampus/memory/longterm-store.ts \
        packages/core/src/brain/limbic/hippocampus/memory/memory-rank.ts \
        packages/core/src/brain/limbic/hippocampus/memory/memory-rank.test.ts \
        packages/core/src/brain/limbic/hippocampus/memory/memory-gateway.ts
git commit -m "feat(memory): salience-modulated decay ranking (salienceWeight/halfLife/recency)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: SQL `dims` column + idempotent migration

**Files:**
- Modify: `packages/core/src/brain/limbic/hippocampus/memory/memory-sql.ts` (`buildSchemaSql` ~27-49, `buildInsertSql` ~64-67, `buildKnnSql` ~89-98)
- Modify: `packages/core/src/brain/limbic/hippocampus/memory/memory-provenance.ts` (`MIGRATION_COLUMNS` ~39-41)
- Test: `packages/core/src/brain/limbic/hippocampus/memory/memory-sql.test.ts`, `packages/core/src/brain/limbic/hippocampus/memory/memory-provenance.test.ts`

**Interfaces:**
- Consumes: Phase 1's `buildSchemaSql`/`buildInsertSql`/`buildKnnSql` (5-column `provenance` shape) and `MIGRATION_COLUMNS`.
- Produces: `buildSchemaSql()` emits a nullable `dims TEXT`; `buildInsertSql()` binds 6 columns `(ts, source, tags, text, provenance, dims)`; `buildKnnSql()` SELECT includes `m.dims AS dims`; `MIGRATION_COLUMNS` contains a `dims` entry with a defaultless `ADD COLUMN dims TEXT`.

- [ ] **Step 1: Write the failing tests**

Append to `memory-sql.test.ts`:

```ts
describe("buildSchemaSql — dims column", () => {
  it("declares dims as a nullable TEXT column (no default)", () => {
    const sql = buildSchemaSql()
    expect(sql).toContain("dims TEXT")
    // nullable: the dims line carries neither NOT NULL nor DEFAULT
    const dimsLine = sql.split("\n").find((l) => l.includes("dims TEXT"))
    expect(dimsLine).toBeDefined()
    expect(dimsLine!).not.toContain("NOT NULL")
    expect(dimsLine!).not.toContain("DEFAULT")
  })
})

describe("buildInsertSql — dims column", () => {
  it("inserts six columns in a fixed order with six binds", () => {
    const sql = buildInsertSql()
    expect(sql).toContain("(ts, source, tags, text, provenance, dims)")
    expect(sql).toContain("VALUES (?, ?, ?, ?, ?, ?)")
  })
})

describe("buildKnnSql — dims column", () => {
  it("selects dims alongside the ranked row", () => {
    expect(buildKnnSql(5)).toContain("m.dims AS dims")
  })
})
```

Append to `memory-provenance.test.ts`:

```ts
describe("MIGRATION_COLUMNS — dims", () => {
  it("adds dims as a nullable column with no default (legacy rows → NULL)", () => {
    const dims = MIGRATION_COLUMNS.find((c) => c.name === "dims")
    expect(dims).toBeDefined()
    expect(dims!.ddl).toContain("ADD COLUMN dims TEXT")
    expect(dims!.ddl).not.toContain("NOT NULL")
    expect(dims!.ddl).not.toContain("DEFAULT")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest --run packages/core/src/brain/limbic/hippocampus/memory/memory-sql.test.ts packages/core/src/brain/limbic/hippocampus/memory/memory-provenance.test.ts`
Expected: FAIL on the new assertions.

- [ ] **Step 3: Add `dims` to `buildSchemaSql`**

In `memory-sql.ts`, replace the `memories` table tail:

```ts
    `  text TEXT NOT NULL,`,
    `  provenance TEXT NOT NULL DEFAULT 'episodic'`,
    `);`,
```

with:

```ts
    `  text TEXT NOT NULL,`,
    `  provenance TEXT NOT NULL DEFAULT 'episodic',`,
    `  dims TEXT`,
    `);`,
```

(Only the FIRST `);` — the `memories` table. Leave the `meta` table's `);` untouched.)

- [ ] **Step 4: Add `dims` to `buildInsertSql`**

Replace:

```ts
/** Append a record row. Bind order: ts, source, tags, text, provenance. id auto-assigned. */
export function buildInsertSql(): string {
  return `INSERT INTO memories (ts, source, tags, text, provenance) VALUES (?, ?, ?, ?, ?)`
}
```

with:

```ts
/** Append a record row. Bind order: ts, source, tags, text, provenance, dims. id auto-assigned. */
export function buildInsertSql(): string {
  return `INSERT INTO memories (ts, source, tags, text, provenance, dims) VALUES (?, ?, ?, ?, ?, ?)`
}
```

- [ ] **Step 5: Add `dims` to `buildKnnSql` SELECT**

Replace:

```ts
    `SELECT m.id AS id, m.ts AS ts, m.source AS source, m.provenance AS provenance, m.tags AS tags, m.text AS text, v.distance AS distance`,
```

with:

```ts
    `SELECT m.id AS id, m.ts AS ts, m.source AS source, m.provenance AS provenance, m.dims AS dims, m.tags AS tags, m.text AS text, v.distance AS distance`,
```

- [ ] **Step 6: Add the migration column**

In `memory-provenance.ts`, replace:

```ts
export const MIGRATION_COLUMNS: ReadonlyArray<{ name: string; ddl: string }> = [
  { name: "provenance", ddl: "ALTER TABLE memories ADD COLUMN provenance TEXT NOT NULL DEFAULT 'episodic'" },
]
```

with:

```ts
export const MIGRATION_COLUMNS: ReadonlyArray<{ name: string; ddl: string }> = [
  { name: "provenance", ddl: "ALTER TABLE memories ADD COLUMN provenance TEXT NOT NULL DEFAULT 'episodic'" },
  // dims is nullable with NO default — legacy rows stay NULL → neutral salience
  // at recall (Phase 3). No backfill: an un-scored old memory has no signature.
  { name: "dims", ddl: "ALTER TABLE memories ADD COLUMN dims TEXT" },
]
```

Also update the trailing comment on `MIGRATION_COLUMNS`'s doc block from `(A list of one today; Phase 3 adds \`dims\`.)` to `(provenance + dims.)` if present — cosmetic; skip if the comment already reads differently.

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm vitest --run packages/core/src/brain/limbic/hippocampus/memory/memory-sql.test.ts packages/core/src/brain/limbic/hippocampus/memory/memory-provenance.test.ts`
Expected: PASS (existing + new).

- [ ] **Step 8: Typecheck**

Run: `pnpm nx run @roci/core:typecheck --skip-nx-cache`
Expected: SUCCESS.

- [ ] **Step 9: Commit**

```bash
cd /Users/vcarl/workspace/roci/.claude/worktrees/memory-provenance
git add packages/core/src/brain/limbic/hippocampus/memory/memory-sql.ts \
        packages/core/src/brain/limbic/hippocampus/memory/memory-sql.test.ts \
        packages/core/src/brain/limbic/hippocampus/memory/memory-provenance.ts \
        packages/core/src/brain/limbic/hippocampus/memory/memory-provenance.test.ts
git commit -m "feat(memory): add nullable dims column to schema/insert/knn SQL + migration

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Generated CLI stores/emits `dims` + NDJSON formatter parity

Mirrors EXACTLY how Phase 1 threaded `provenance` through this generated bun script (that is your template — read `buildMemoryCliScript` before editing).

**Files:**
- Modify: `packages/core/src/brain/limbic/hippocampus/memory/memory-cli.ts` (`remember`/`promote` binds, `knnSql`, `fmt`, `recent` SELECT)
- Modify: `packages/core/src/brain/limbic/hippocampus/memory/memory-format.ts` (`MemoryRow` + `formatResults`)
- Test: `packages/core/src/brain/limbic/hippocampus/memory/memory-cli.test.ts`, `packages/core/src/brain/limbic/hippocampus/memory/memory-format.test.ts`

**Interfaces:**
- Consumes: `buildInsertSql`'s 6-column shape (Task 2).
- Produces: the generated CLI parses `--dims <json>` on `remember`, binds it (6th value) on `remember`/`promote` (null for promote), emits `dims: r.dims ? JSON.parse(r.dims) : null` in `search`/`recent` NDJSON, and SELECTs `m.dims`. `formatResults`/`MemoryRow` carry `dims`.

- [ ] **Step 1: Write the failing tests**

Append to `memory-format.test.ts`:

```ts
describe("formatResults — dims", () => {
  it("emits a parsed dims object per row", () => {
    const out = formatResults([
      { id: 1, distance: 0.1, ts: "2026-07-01T00:00:00Z", source: "observe", provenance: "grounded", dims: JSON.stringify({ safety: 0.8 }), tags: null, text: "hull breach" },
    ])
    expect(JSON.parse(out).dims).toEqual({ safety: 0.8 })
  })
  it("emits null dims when the column is null", () => {
    const out = formatResults([
      { id: 1, distance: 0.1, ts: "2026-07-01T00:00:00Z", source: "orient", provenance: "inferred", dims: null, tags: null, text: "guess" },
    ])
    expect(JSON.parse(out).dims).toBeNull()
  })
})
```

Append to `memory-cli.test.ts`:

```ts
describe("buildMemoryCliScript — dims", () => {
  const script = buildMemoryCliScript({ embedBaseUrl: "http://127.0.0.1:8090" })
  it("parses the --dims flag and binds it on remember (6th value)", () => {
    expect(script).toContain('takeFlag(a2.rest, ["--dims"])')
    expect(script).toContain("prov, dimsJson)")
  })
  it("binds null dims on promote", () => {
    expect(script).toContain('"promotion", text, prov, null)')
  })
  it("selects dims and emits it parsed in search/recent output", () => {
    expect(script).toContain("m.dims AS dims")
    expect(script).toContain("dims: r.dims ? JSON.parse(r.dims) : null")
    expect(script).toContain("SELECT id, ts, source, provenance, dims, tags, text FROM memories")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest --run packages/core/src/brain/limbic/hippocampus/memory/memory-format.test.ts packages/core/src/brain/limbic/hippocampus/memory/memory-cli.test.ts`
Expected: FAIL on the new assertions.

- [ ] **Step 3: Update `memory-format.ts`**

Replace the `MemoryRow` interface:

```ts
/** A KNN/recent row as returned by the sqlite-vec join (tags is the raw db column). */
export interface MemoryRow {
  id: number
  /** vec0 distance; absent for `recent` (no embedding query). */
  distance?: number
  ts: string
  source: string
  /** Objective trust-tier (present post-migration). */
  provenance?: string
  /** comma-joined tags, or null/empty when none. */
  tags: string | null
  text: string
}
```

with:

```ts
/** A KNN/recent row as returned by the sqlite-vec join (tags is the raw db column). */
export interface MemoryRow {
  id: number
  /** vec0 distance; absent for `recent` (no embedding query). */
  distance?: number
  ts: string
  source: string
  /** Objective trust-tier (present post-migration). */
  provenance?: string
  /** Raw JSON dims column (`{drive: weight/5}`); null/absent for legacy/non-observe rows. */
  dims?: string | null
  /** comma-joined tags, or null/empty when none. */
  tags: string | null
  text: string
}
```

In `formatResults`, replace the `obj` literal:

```ts
      const obj: Record<string, unknown> = {
        id: r.id,
        ts: r.ts,
        source: r.source,
        provenance: r.provenance,
        tags: splitTags(r.tags),
        text: r.text,
      }
```

with:

```ts
      const obj: Record<string, unknown> = {
        id: r.id,
        ts: r.ts,
        source: r.source,
        provenance: r.provenance,
        dims: r.dims ? JSON.parse(r.dims) : null,
        tags: splitTags(r.tags),
        text: r.text,
      }
```

- [ ] **Step 4: Update `memory-cli.ts` — parse `--dims` + bind on `remember`**

In the `remember` branch, replace:

```ts
if (verb === "remember") {
  const a1 = takeFlag(args, ["--tags"]);
  const a2 = takeFlag(a1.rest, ["--source"]);
  const text = a2.rest[0];
  if (!text) { console.error(USAGE); process.exit(2); }
  const tags = a1.value ? splitTags(a1.value).join(",") : null;
  const source = a2.value || "conscious";
  const vec = await embed(text);
  const db = openDb();
  const prov = classify(source);
  const info = db.prepare(INSERT_SQL).run(new Date().toISOString(), source, tags, text, prov);
```

with:

```ts
if (verb === "remember") {
  const a1 = takeFlag(args, ["--tags"]);
  const a2 = takeFlag(a1.rest, ["--source"]);
  const a3 = takeFlag(a2.rest, ["--dims"]);
  const text = a3.rest[0];
  if (!text) { console.error(USAGE); process.exit(2); }
  const tags = a1.value ? splitTags(a1.value).join(",") : null;
  const source = a2.value || "conscious";
  // dims arrives as a JSON string; stored verbatim as TEXT (null when absent).
  const dimsJson = a3.value || null;
  const vec = await embed(text);
  const db = openDb();
  const prov = classify(source);
  const info = db.prepare(INSERT_SQL).run(new Date().toISOString(), source, tags, text, prov, dimsJson);
```

- [ ] **Step 5: Bind null dims on `promote`**

In the `promote` branch, replace:

```ts
    const vec = await embed(text);
    const prov = classify("promotion");
    const info = db.prepare(INSERT_SQL).run(new Date().toISOString(), "promotion", "promotion", text, prov);
```

with:

```ts
    const vec = await embed(text);
    const prov = classify("promotion");
    const info = db.prepare(INSERT_SQL).run(new Date().toISOString(), "promotion", "promotion", text, prov, null);
```

- [ ] **Step 6: Emit `dims` (`knnSql`, `fmt`, `recent` SELECT)**

Replace `knnSql`'s returned SELECT string:

```ts
  return "SELECT m.id AS id, m.ts AS ts, m.source AS source, m.provenance AS provenance, m.tags AS tags, m.text AS text, v.distance AS distance "
    + "FROM memories_vec v JOIN memories m ON m.id = v.id "
    + "WHERE v.embedding MATCH ? AND k = " + ek + " ORDER BY v.distance";
```

with:

```ts
  return "SELECT m.id AS id, m.ts AS ts, m.source AS source, m.provenance AS provenance, m.dims AS dims, m.tags AS tags, m.text AS text, v.distance AS distance "
    + "FROM memories_vec v JOIN memories m ON m.id = v.id "
    + "WHERE v.embedding MATCH ? AND k = " + ek + " ORDER BY v.distance";
```

Replace the `fmt` object:

```ts
    const o = { id: r.id, ts: r.ts, source: r.source, provenance: r.provenance, tags: splitTags(r.tags), text: r.text };
```

with:

```ts
    const o = { id: r.id, ts: r.ts, source: r.source, provenance: r.provenance, dims: r.dims ? JSON.parse(r.dims) : null, tags: splitTags(r.tags), text: r.text };
```

Replace the `recent` SELECT:

```ts
  const rows = db.query("SELECT id, ts, source, provenance, tags, text FROM memories ORDER BY id DESC LIMIT " + n).all();
```

with:

```ts
  const rows = db.query("SELECT id, ts, source, provenance, dims, tags, text FROM memories ORDER BY id DESC LIMIT " + n).all();
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm vitest --run packages/core/src/brain/limbic/hippocampus/memory/memory-format.test.ts packages/core/src/brain/limbic/hippocampus/memory/memory-cli.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck**

Run: `pnpm nx run @roci/core:typecheck --skip-nx-cache`
Expected: SUCCESS.

- [ ] **Step 9: Commit**

```bash
cd /Users/vcarl/workspace/roci/.claude/worktrees/memory-provenance
git add packages/core/src/brain/limbic/hippocampus/memory/memory-cli.ts \
        packages/core/src/brain/limbic/hippocampus/memory/memory-cli.test.ts \
        packages/core/src/brain/limbic/hippocampus/memory/memory-format.ts \
        packages/core/src/brain/limbic/hippocampus/memory/memory-format.test.ts
git commit -m "feat(memory): CLI stores + emits dims (--dims parse, bind, NDJSON emit)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Store seam write path — `LongtermStore.remember` carries `dims`

**Files:**
- Modify: `packages/core/src/brain/limbic/hippocampus/memory/longterm-store.ts` (`remember` entry type ~95-100; Live `remember` impl ~164-170)
- Test: `packages/core/src/brain/limbic/hippocampus/memory/longterm-store.test.ts`

**Interfaces:**
- Consumes: the CLI `--dims` flag (Task 3); `MemoryHit.dims?` (Task 1).
- Produces: `LongtermStore.remember`'s entry type gains `readonly dims?: Record<string, number>`; the Live impl appends ` --dims '<json>'` (shell-quoted) **only when dims is non-empty**.

- [ ] **Step 1: Write the failing test**

Append to the `describe("LongtermStore.remember / recall", …)` block in `longterm-store.test.ts`:

```ts
  it("remember shells --dims with quoted JSON when dims is non-empty", async () => {
    const captured: string[][] = []
    await Effect.runPromise(
      Effect.flatMap(LongtermStore, (s) =>
        s.remember("cid", char, { text: "hull breach", source: "observe", tags: ["escalate", "safety"], dims: { safety: 0.8 } }),
      ).pipe(Effect.provide(LongtermStoreLive.pipe(Layer.provide(dockerStub("", captured))))),
    )
    const joined = captured.flat().join(" ")
    expect(joined).toContain(`--dims '{"safety":0.8}'`)
    expect(joined).toContain(`--source 'observe'`)
  })

  it("remember omits --dims entirely when dims is empty or absent", async () => {
    const captured: string[][] = []
    await Effect.runPromise(
      Effect.flatMap(LongtermStore, (s) =>
        s.remember("cid", char, { text: "a guess", source: "orient", tags: [], dims: {} }),
      ).pipe(Effect.provide(LongtermStoreLive.pipe(Layer.provide(dockerStub("", captured))))),
    )
    expect(captured.flat().join(" ")).not.toContain("--dims")
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest --run packages/core/src/brain/limbic/hippocampus/memory/longterm-store.test.ts`
Expected: FAIL — `dims` is not an accepted property on the `remember` entry (type error at compile / assertion fails: no `--dims` emitted).

- [ ] **Step 3: Add `dims?` to the `remember` entry type**

In `longterm-store.ts`, replace the `remember` method signature in the `LongtermStore` service interface:

```ts
    /** Persist a single memory with an explicit source + tags (in-container `memory remember`). */
    readonly remember: (
      containerId: string,
      char: CharacterConfig,
      entry: { readonly text: string; readonly source: string; readonly tags: ReadonlyArray<string> },
    ) => Effect.Effect<void, Error>
```

with:

```ts
    /** Persist a single memory with an explicit source + tags + optional dims signature (in-container `memory remember`). */
    readonly remember: (
      containerId: string,
      char: CharacterConfig,
      entry: {
        readonly text: string
        readonly source: string
        readonly tags: ReadonlyArray<string>
        readonly dims?: Record<string, number>
      },
    ) => Effect.Effect<void, Error>
```

- [ ] **Step 4: Emit `--dims` in the Live `remember` impl**

Replace:

```ts
      remember: (containerId, char, entry) => {
        const tagsArg = entry.tags.length > 0 ? ` --tags ${shQuote(entry.tags.join(","))}` : ""
        const cmd =
          `${cd(char)} && ${MEMORY_CLI_PATH} remember ${shQuote(entry.text)}` +
          `${tagsArg} --source ${shQuote(entry.source)}`
        return docker.exec(containerId, ["bash", "-lc", cmd]).pipe(Effect.mapError(fail), Effect.asVoid)
      },
```

with:

```ts
      remember: (containerId, char, entry) => {
        const tagsArg = entry.tags.length > 0 ? ` --tags ${shQuote(entry.tags.join(","))}` : ""
        // Only pass --dims when there is a non-empty signature; an empty/absent
        // dims → NULL column → neutral salience at recall.
        const dimsArg =
          entry.dims && Object.keys(entry.dims).length > 0
            ? ` --dims ${shQuote(JSON.stringify(entry.dims))}`
            : ""
        const cmd =
          `${cd(char)} && ${MEMORY_CLI_PATH} remember ${shQuote(entry.text)}` +
          `${tagsArg} --source ${shQuote(entry.source)}${dimsArg}`
        return docker.exec(containerId, ["bash", "-lc", cmd]).pipe(Effect.mapError(fail), Effect.asVoid)
      },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest --run packages/core/src/brain/limbic/hippocampus/memory/longterm-store.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 6: Typecheck**

Run: `pnpm nx run @roci/core:typecheck --skip-nx-cache`
Expected: SUCCESS. The gateway's `store.remember(...)` call (Task 5 adds `dims`) still compiles now because `dims?` is optional.

- [ ] **Step 7: Commit**

```bash
cd /Users/vcarl/workspace/roci/.claude/worktrees/memory-provenance
git add packages/core/src/brain/limbic/hippocampus/memory/longterm-store.ts \
        packages/core/src/brain/limbic/hippocampus/memory/longterm-store.test.ts
git commit -m "feat(memory): LongtermStore.remember threads optional dims to the CLI

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Gateway — capture dims, load the salience profile, wire it into rerank

Lands the read+write gateway change as one green commit: `MemoryWrite.dims`, the `observeMemories` capture, the `store.remember` dims thread, the `CharacterFs`-backed profile load (with a per-`(container,char)` parsed-profile cache), the `rerank(hits, k, now, salience)` real wiring, the gateway-test harness fix, and the production layer wiring in `cli.ts`.

**Files:**
- Modify: `packages/core/src/brain/limbic/hippocampus/memory/memory-gateway.ts` (imports; `MemoryWrite` ~8-12; `observeMemories` ~21-27; `remember` impl ~142-157; `recall` impl ~158-169; `MemoryGatewayLive` ~127-172)
- Modify: `packages/core/src/brain/limbic/hippocampus/memory/memory-gateway.test.ts` (observe-dims expectation ~48-55; `run` harness ~44-45)
- Modify: `apps/roci/src/cli.ts` (`serviceLayer` ~738)

**Interfaces:**
- Consumes: `CharacterFs` + `CharacterFs.readSalience` and `parseSalience`/`TEMPLATE_SALIENCE` (Phase 2); `rerank` (Task 1); `LongtermStore.remember`'s `dims?` (Task 4).
- Produces:
  - `MemoryWrite` gains `readonly dims?: Record<string, number>`.
  - `observeMemories` sets `dims = observe.drive ? { [observe.drive]: observe.weight / 5 } : {}`.
  - `MemoryGatewayLive: Layer.Layer<MemoryGateway, never, LongtermStore | CharacterFs>` — `recall` loads the parsed salience profile (cached per `(container,char)`) and feeds it to `rerank`.
  - `cli.ts`: the `MemoryGatewayLive` branch now also provides `CharacterFsLive`.

- [ ] **Step 1: Write / update the failing tests**

In `memory-gateway.test.ts`, replace the `observeMemories` assertion in the `"pure capture extractors"` describe:

```ts
  it("observeMemories drops discards and captures the reason with disposition + drive tags", () => {
    const discard = { disposition: "discard", emotionalWeight: "😐", drive: "curiosity", weight: 0, reason: "noise" } as ObserveResult
    const keep = { disposition: "escalate", emotionalWeight: "😨", drive: "safety", weight: 9, reason: "hull breach imminent" } as ObserveResult
    expect(observeMemories(discard)).toEqual([])
    expect(observeMemories(keep)).toEqual([
      { source: "observe", text: "hull breach imminent", tags: ["escalate", "safety"] },
    ])
  })
```

with:

```ts
  it("observeMemories captures the reason with disposition+drive tags AND a {drive: weight/5} dims signature", () => {
    const discard = { disposition: "discard", emotionalWeight: "😐", drive: "curiosity", weight: 0, reason: "noise" } as ObserveResult
    const keep = { disposition: "escalate", emotionalWeight: "😨", drive: "safety", weight: 4, reason: "hull breach imminent" } as ObserveResult
    expect(observeMemories(discard)).toEqual([])
    expect(observeMemories(keep)).toEqual([
      { source: "observe", text: "hull breach imminent", tags: ["escalate", "safety"], dims: { safety: 0.8 } },
    ])
  })

  it("observeMemories carries empty dims when the event bears on no drive", () => {
    const keep = { disposition: "accumulate", emotionalWeight: "😐", drive: null, weight: 3, reason: "a ship passed by" } as ObserveResult
    expect(observeMemories(keep)).toEqual([
      { source: "observe", text: "a ship passed by", tags: ["accumulate"], dims: {} },
    ])
  })
```

Then update the `run` harness so the gateway layer (now requiring `CharacterFs`) is satisfiable. Replace the imports + `run` helper at the top of the file:

```ts
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
  Effect.runPromise(
    program.pipe(
      Effect.provide(MemoryGatewayLive.pipe(Layer.provide(Layer.merge(store.layer, fakeCharFs())))),
    ),
  )
```

Add these two imports next to the existing ones (a value import of `CharacterFs` plus `Context` for the cast, and the Phase 2 template):

```ts
import { Context } from "effect"
import { CharacterFs } from "../../../../services/CharacterFs.js"
import { TEMPLATE_SALIENCE } from "../../../../core/salience.js"
```

And add this fake `CharacterFs` layer helper immediately below `fakeStore`:

```ts
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
```

(Merge the two `import { Effect, Layer } from "effect"` / `import { Context } from "effect"` lines into one `import { Context, Effect, Layer } from "effect"` if your linter prefers; both are valid.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest --run packages/core/src/brain/limbic/hippocampus/memory/memory-gateway.test.ts`
Expected: FAIL — `observeMemories` does not yet emit `dims`; and `MemoryGatewayLive` does not yet require/consume `CharacterFs` (the `fakeCharFs` provide is harmless but the observe assertions fail).

- [ ] **Step 3: Update `memory-gateway.ts` imports**

Replace the top import block:

```ts
import { Context, Effect, Layer, Clock } from "effect"
import type { CharacterConfig } from "../../../../services/CharacterFs.js"
import { LongtermStore, type MemoryHit } from "./longterm-store.js"
import type { ObserveResult, OrientResult, DecideResult, EvaluateResult } from "../../../../skills/types.js"
import { rerank, RERANK_OVERFETCH } from "./memory-rank.js"
```

with:

```ts
import { Context, Effect, Layer, Clock } from "effect"
import { CharacterFs, type CharacterConfig } from "../../../../services/CharacterFs.js"
import { LongtermStore, type MemoryHit } from "./longterm-store.js"
import type { ObserveResult, OrientResult, DecideResult, EvaluateResult } from "../../../../skills/types.js"
import { rerank, RERANK_OVERFETCH } from "./memory-rank.js"
import { parseSalience, TEMPLATE_SALIENCE } from "../../../../core/salience.js"
```

- [ ] **Step 4: Add `dims` to `MemoryWrite` and capture it in `observeMemories`**

Replace the `MemoryWrite` interface:

```ts
/** One unit to persist: the source phase, the text, and derived tags. */
export interface MemoryWrite {
  readonly source: string
  readonly text: string
  readonly tags: ReadonlyArray<string>
}
```

with:

```ts
/** One unit to persist: the source phase, the text, derived tags, and an optional salience signature. */
export interface MemoryWrite {
  readonly source: string
  readonly text: string
  readonly tags: ReadonlyArray<string>
  /** Per-memory salience signature `{drive: weight/5}` (observe writes only; empty otherwise). */
  readonly dims?: Record<string, number>
}
```

Replace `observeMemories`:

```ts
/** Hindbrain observe → memory: the appraisal reason, unless discarded/empty. */
export function observeMemories(observe: ObserveResult): MemoryWrite[] {
  if (observe.disposition === "discard") return []
  const reason = observe.reason?.trim()
  if (!reason) return []
  const tags = [observe.disposition, ...(observe.drive ? [observe.drive] : [])]
  return [{ source: "observe", text: clip(reason), tags }]
}
```

with:

```ts
/**
 * Hindbrain observe → memory: the appraisal reason, unless discarded/empty. The
 * discarded observe `weight`/`drive` become the memory's salience signature
 * `dims` (Phase 3 §3): `{ [drive]: weight/5 }`, or `{}` when the event bears on no
 * drive. weight is already clamped to 0–5 upstream by the observe skill.
 */
export function observeMemories(observe: ObserveResult): MemoryWrite[] {
  if (observe.disposition === "discard") return []
  const reason = observe.reason?.trim()
  if (!reason) return []
  const tags = [observe.disposition, ...(observe.drive ? [observe.drive] : [])]
  const dims = observe.drive ? { [observe.drive]: observe.weight / 5 } : {}
  return [{ source: "observe", text: clip(reason), tags, dims }]
}
```

- [ ] **Step 5: Thread `dims` through the gateway `remember`, and load the profile in `recall`**

Replace the whole `MemoryGatewayLive` definition:

```ts
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
          // Over-fetch, then re-rank down to k by relevance × trust × salience-decay.
          const hits = yield* store
            .recall(containerId, char, q, { k: opts.k * RERANK_OVERFETCH, tags: opts.tags })
            .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<MemoryHit>)))
          const now = yield* Clock.currentTimeMillis
          // Phase 3 Task 5 replaces this neutral placeholder with the character's
          // parsed salience profile (CharacterFs.readSalience → parseSalience).
          const salience: Record<string, number> = {}
          const ranked = rerank(hits, opts.k, now, salience)
          return formatRecall(ranked, opts.label, now, opts.maxChars)
        }),
    })
  }),
)
```

with:

```ts
export const MemoryGatewayLive: Layer.Layer<MemoryGateway, never, LongtermStore | CharacterFs> = Layer.effect(
  MemoryGateway,
  Effect.gen(function* () {
    const store = yield* LongtermStore
    const charFs = yield* CharacterFs
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
    // Per-(container,char) parsed salience profile cache — readSalience shells no
    // container, but parsing every recall is wasteful (Phase 3 §9). The profile is
    // authored once at scaffold time, so caching for the process lifetime is safe.
    const profileCache = new Map<string, Record<string, number>>()
    const loadSalience = (containerId: string, char: CharacterConfig) =>
      Effect.gen(function* () {
        const key = `${containerId}:${char.name}`
        const cached = profileCache.get(key)
        if (cached) return cached
        const md = yield* charFs
          .readSalience(char)
          .pipe(Effect.catchAll(() => Effect.succeed(TEMPLATE_SALIENCE)))
        const profile = parseSalience(md)
        profileCache.set(key, profile)
        return profile
      })
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
            .remember(containerId, char, { text, source: write.source, tags: write.tags, dims: write.dims })
            .pipe(Effect.catchAll(() => Effect.void))
        }),
      recall: (containerId, char, query, opts) =>
        Effect.gen(function* () {
          const q = query.trim()
          if (!q) return ""
          // Over-fetch, then re-rank down to k by relevance × trust × salience-decay.
          const hits = yield* store
            .recall(containerId, char, q, { k: opts.k * RERANK_OVERFETCH, tags: opts.tags })
            .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<MemoryHit>)))
          const now = yield* Clock.currentTimeMillis
          const salience = yield* loadSalience(containerId, char)
          const ranked = rerank(hits, opts.k, now, salience)
          return formatRecall(ranked, opts.label, now, opts.maxChars)
        }),
    })
  }),
)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest --run packages/core/src/brain/limbic/hippocampus/memory/memory-gateway.test.ts`
Expected: PASS (observe-dims cases + existing recall/dedup cases; the `fakeCharFs` layer satisfies the new `CharacterFs` requirement).

- [ ] **Step 7: Wire `CharacterFsLive` into the production `MemoryGatewayLive` branch**

In `apps/roci/src/cli.ts`, replace the memory-gateway line in `serviceLayer`:

```ts
  // Memory policy seam (capture + recall) for the cortex loop. Depends on LongtermStore → Docker.
  MemoryGatewayLive.pipe(Layer.provide(LongtermStoreLive.pipe(Layer.provide(DockerLive)))),
```

with:

```ts
  // Memory policy seam (capture + recall) for the cortex loop. Depends on
  // LongtermStore → Docker AND CharacterFs (for the salience profile at recall,
  // Phase 3). CharacterFsLive needs FileSystem — already a serviceLayer-level
  // requirement (CharacterFsLive is a sibling member), so no new top-level dep.
  MemoryGatewayLive.pipe(
    Layer.provide(LongtermStoreLive.pipe(Layer.provide(DockerLive))),
    Layer.provide(CharacterFsLive),
  ),
```

(`CharacterFsLive` is already imported in `cli.ts` — verify the import at the top; no new import needed.)

- [ ] **Step 8: Typecheck (whole package + app — catches the layer requirement)**

Run: `pnpm nx run @roci/core:typecheck --skip-nx-cache && pnpm nx run @roci/roci:typecheck --skip-nx-cache`
Expected: SUCCESS. The `@roci/roci` typecheck proves `serviceLayer` has no residual `CharacterFs` requirement leaking from the `MemoryGatewayLive` branch (the `Layer.provide(CharacterFsLive)` satisfies it locally; `FileSystem` remains satisfied at the runtime boundary as before). If `@roci/roci` is not the project name, discover it: `pnpm nx show projects | grep -i roci`.

- [ ] **Step 9: Commit**

```bash
cd /Users/vcarl/workspace/roci/.claude/worktrees/memory-provenance
git add packages/core/src/brain/limbic/hippocampus/memory/memory-gateway.ts \
        packages/core/src/brain/limbic/hippocampus/memory/memory-gateway.test.ts \
        apps/roci/src/cli.ts
git commit -m "feat(memory): capture observe dims + salience-profile-driven recall rerank

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Integration verification

- [ ] **Step 1: Full memory-suite test run**

Run: `pnpm vitest --run packages/core/src/brain/limbic/hippocampus/memory`
Expected: PASS — all files.

- [ ] **Step 2: Full `@roci/core` typecheck without cache**

Run: `pnpm nx run @roci/core:typecheck --skip-nx-cache`
Expected: SUCCESS.

- [ ] **Step 3: Confirm the recall call sites are untouched and correct**

Run: `grep -n "memory.recall\|\.recall(" packages/core/src/brain/stem/loop.ts packages/core/src/brain/limbic/hippocampus/identity-context.ts`
Expected: three call sites (`loop.ts:385`, `loop.ts:956`, `identity-context.ts:118`), each still passing `{ k, label, maxChars? }` — the `MemoryGatewayApi.recall` external signature did not change, so no edits were needed.

- [ ] **Step 4: Grep gate — decay knobs are single-site**

Run:
```bash
cd /Users/vcarl/workspace/roci/.claude/worktrees/memory-provenance
grep -rn "HALF_LIFE_MIN\|HALF_LIFE_MAX\|NEUTRAL_SALIENCE" packages/core/src --include="*.ts" | grep -v ".test.ts"
```
Expected: the definitions appear ONLY in `memory-rank.ts` (three `export const` lines + their uses inside `halfLife`/`salienceWeight`). No copies elsewhere in non-test source.

- [ ] **Step 5: Grep gate — injection surface + synthesis untouched**

Run:
```bash
cd /Users/vcarl/workspace/roci/.claude/worktrees/memory-provenance
git diff --name-only main -- packages/core/src/brain/limbic/hippocampus/macro.ts packages/core/src/skills 2>/dev/null
grep -n "You recall\|Relevant memories" packages/core/src/brain/limbic/hippocampus/memory/memory-gateway.ts
```
Expected: the first command prints NOTHING (macro.ts / skills prompts untouched); the second prints no results (formatRecall does not hardcode labels — they arrive via `opts.label`, unchanged from Phase 1). Salience stays implicit in ordering; no new injection prose.

- [ ] **Step 6: Whole-repo build (the pre-commit gate, run explicitly)**

Run: `pnpm nx run-many -t build --skip-nx-cache`
Expected: SUCCESS across all projects.

- [ ] **Step 7: Sanity-read the generated CLI string**

Run:
```bash
cd /Users/vcarl/workspace/roci/.claude/worktrees/memory-provenance
pnpm exec tsx -e "import('./packages/core/src/brain/limbic/hippocampus/memory/memory-cli.js').then(m => console.log(m.buildMemoryCliScript({embedBaseUrl:'http://127.0.0.1:8090'})))" 2>/dev/null | grep -nE "\-\-dims|m.dims AS dims|prov, dimsJson\)|JSON.parse\(r.dims\)|prov, null\)" | head
```
Expected: lines showing the `--dims` flag parse, the `m.dims AS dims` SELECT, the `remember` bind (`prov, dimsJson)`), the `fmt`/`recent` emit (`JSON.parse(r.dims)`), and the `promote` null bind (`prov, null)`). (If `tsx` is unavailable, the `memory-cli.test.ts` assertions from Task 3 cover the same substrings.)

- [ ] **Step 8: Final commit (only if a fixup was required)**

```bash
cd /Users/vcarl/workspace/roci/.claude/worktrees/memory-provenance
git add -A packages/core/src apps/roci/src
git commit -m "chore(memory): integration fixups for salience-decay ranking

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

If no fixup was needed, skip this step.

---

## Self-Review

**1. Spec coverage (§3 / §4 / §5 / §7 Phase 3 / §8 P3 / §9):**
- §3 per-memory salience signature: `dims TEXT` column (Task 2) + `observeMemories` sets `{drive: weight/5}` / `{}` (Task 5) + write-path thread (Tasks 3-5). Covered.
- §4 salience-modulated decay + composite: `salienceWeight`/`halfLife`/`recency`/extended `compositeScore`/`rerank` (Task 1); gateway feeds `now` + parsed profile (Task 5). Covered.
- §4 knobs at one site, ms units, commented tunable: Task 1 `HALF_LIFE_MIN`/`HALF_LIFE_MAX`/`NEUTRAL_SALIENCE`; grep gate Task 6 Step 4. Covered.
- §5 injection surface: unchanged — `formatRecall` keeps Phase 1's `(provenance · age)`, salience implicit; Global Constraints + Task 6 Step 5 gate. Covered (no new prose).
- §7 Phase 3 deliverables (dims column; observe capture; CLI store/emit; `MemoryHit.dims`; salience rerank in `memory-rank.ts`; gateway loads profile via `readSalience`/`parseSalience` feeding `rerank` with `now`): Tasks 1-5. Covered.
- §7 acceptance — salient outlives trivial at equal relevance as age grows / relevance dominates at equal trust+salience / legacy null-dims → neutral: Task 1 rerank tests (`salient outlives trivial`, `relevance dominates`, empty/absent dims → NEUTRAL) + nullable-no-default migration (Task 2). Covered.
- §8 P3 tests — observe captures `{drive: weight/5}` + drops/empty on null drive (Task 5); `salienceWeight` single-drive + neutral-when-empty (Task 1); `halfLife` monotonic s=0→MIN/s=1→MAX (Task 1); `recency` 0.5 at one half-life (Task 1); `rerank` salient-outlives + relevance-dominates (Task 1); migration idempotency guard (Task 2 asserts the entry; the CLI's existing PRAGMA loop from Phase 1 applies it — same mechanism Phase 1 tested); CLI embeds dims store/emit (Task 3). All present.
- §9 profile-read cost: parsed-profile cache in the gateway (Task 5). Covered.

**2. Placeholder scan:** No "TBD"/"similar to Task N"/"add error handling". Every code step shows exact code; every run step shows an exact command + expected PASS/FAIL. The one deliberate placeholder — Task 1's neutral `{}` salience in the gateway — is explicitly labeled as a Task-1-only keep-alive and is replaced with real code in Task 5 Step 5 (shown in full).

**3. Type consistency:**
- `MemoryHit.dims?: Record<string, number>` (Task 1) is read by `salienceWeight(hit, salience)` (Task 1), populated at runtime via NDJSON parse (Task 3 emits an object), and written via `LongtermStore.remember` entry `dims?` (Task 4) ← `MemoryWrite.dims?` (Task 5) ← `observeMemories` (Task 5). Same `Record<string, number>` shape end-to-end.
- `salience: Record<string, number>` is the type flowing `parseSalience` (Phase 2 output) → `loadSalience` → `rerank`/`compositeScore`/`salienceWeight` — identical across all signatures.
- `rerank(hits, k, nowMs, salience)` / `compositeScore(hit, nowMs, salience)` defined in Task 1 are called with exactly that arity in Task 1's gateway placeholder and Task 5's real wiring; the ranking tests use the same arity.
- `HALF_LIFE_MIN`/`HALF_LIFE_MAX`/`NEUTRAL_SALIENCE` exported from `memory-rank.ts` (Task 1) are imported by name in `memory-rank.test.ts` (Task 1) only.
- SQL bind order `(ts, source, tags, text, provenance, dims)` is consistent across `buildInsertSql` (Task 2), the CLI `remember`/`promote` `.run(...)` binds (Task 3), and the 6-`?` VALUES.
- `MemoryGatewayLive: Layer.Layer<MemoryGateway, never, LongtermStore | CharacterFs>` (Task 5) matches the production wiring that provides both `LongtermStoreLive` and `CharacterFsLive` (Task 5 Step 7) and the test harness that merges `store.layer` + `fakeCharFs()` (Task 5 Step 1).
No drift found.

---

## Blast-radius notes (pre-answered so the implementer doesn't discover them mid-task)

- **`rerank` signature change → gateway call site.** Handled in the SAME commit (Task 1 Step 5). Only one caller exists (`memory-gateway.ts`); the ranking tests are the only other consumers.
- **`MemoryGatewayLive` gains `CharacterFs` → every provision site.** There are exactly two: production `apps/roci/src/cli.ts:738` (Task 5 Step 7 adds `Layer.provide(CharacterFsLive)`) and the test harness `memory-gateway.test.ts:45` (Task 5 Step 1 merges `fakeCharFs()`). The three external `recall` call sites (`loop.ts:385`/`:956`, `identity-context.ts:118`) consume the `MemoryGateway` *service* (not the layer) via `memory.recall(...)`, whose external signature is unchanged — no edits (verified; Task 6 Step 3 gate).
- **`MemoryHit.dims?` / `remember` `dims?` are OPTIONAL.** Unlike Phase 1's required `provenance`, these are optional, so **no** existing `MemoryHit`/remember-entry literal in tests (`memory-rank.test.ts`, `memory-gateway.test.ts`, `macro.test.ts`, `longterm-store.test.ts`, and the CLI-emitted NDJSON parsed at runtime) needs a mechanical field addition. Confirmed by grep: the only `MemoryHit` literal builders are those test helper `hit(...)` factories + `macro.ts`'s `renderMemoryHits` (reads `.source`/`.tags`/`.text` only). The blast radius is therefore just the two files that must observe the new behavior (Task 1 rank tests, Task 5 gateway tests), both rewritten in-plan.
- **`CharacterFsLive` needs `FileSystem`.** Providing it into the `MemoryGatewayLive` branch adds `FileSystem` to that branch's requirements, but `CharacterFsLive` is already a sibling `serviceLayer` member contributing the same `FileSystem` requirement, satisfied at the app runtime boundary (`NodeFileSystem`/`NodeContext`). No new top-level dependency; Task 5 Step 8 typechecks the app to prove it.

## Hand-off / what Phase 3 deliberately leaves for later (spec §6/§9)

- Per-memory scoring of the character's *extra* (non-drive) salience dimensions — v1 memory `dims` only ever carry drive dimensions from `observe.drive`, so extras in the profile weight nothing yet (natural Phase 4).
- Salience as a *rank boost* (not only a decay knob) — v1 is decay-only per the design decision; revisit if a QA run shows salient memories under-surfacing when fresh.
- Layer C reputation feedback; `{{synthesis}}`/macro provenance+salience surfacing; retro-scoring legacy rows.
- **Knob tuning is behavioral:** `HALF_LIFE_MIN/MAX` and `NEUTRAL_SALIENCE` are first-guesses — validate + retune in a roci QA run (do salient memories persist and trivial ones fade at plausible rates?). One edit site in `memory-rank.ts`.
