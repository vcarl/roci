# Valence Lexicon Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-contained, fully-tested `valence` module that encodes emotional state as positions on bipolar poetic axes (`"from X to Y: Z"`), parses that format, accumulates a lifetime emotional-range record, and narrativizes it — with no changes to the live cortex.

**Architecture:** A new pure-TypeScript module under `packages/core/src/valence/`. Five focused files (types, template lexicons, parser, range accumulator, narrativizer) plus a barrel. No Effect, no I/O, no live-cortex wiring — every function is a pure transform, unit-tested with Vitest. Live integration (changing `ObserveResult`/`OrientResult`, wiring the accumulator into the loop, wiring the narrativizer into `dream.ts`) is a deliberately separate later plan.

**Tech Stack:** TypeScript (strict, ESM), Vitest, Biome. Package: `@roci/core` (`packages/core`).

**Source spec:** `docs/superpowers/specs/2026-06-20-cortex-answering-model-challenges-design.md` §4.

## Global Constraints

- **Additive only** — create files under `packages/core/src/valence/` and add one export line to `packages/core/src/index.ts`. Do **not** modify `skills/types.ts`, the skill `.md` templates, `dream.ts`, or any cortex tier — live integration is out of scope (spec §6, "standalone module first").
- **ESM with explicit suffixes** — all intra-package imports end in `.js` (e.g. `import { ... } from "./types.js"`).
- **Style** — 2-space indentation, JSDoc on exported symbols, `readonly` on interface fields, no `default` exports. Mirror `packages/core/src/core/limbic/hypothalamus/sdk-payload.ts`.
- **Pure** — no Effect, no async, no filesystem. Plain functions and consts.
- **Tests** — Vitest, colocated `*.test.ts`. Run all: `pnpm test`. Run one file: `pnpm vitest --run <path>`. New files are auto-discovered by `packages/core/vitest.config.ts`; no config changes.
- **Lint** — `pnpm check` (Biome) must pass before each commit. The module style above mirrors `sdk-payload.ts` (2-space, no semicolons, double quotes, `Number.parseFloat`); if Biome still reports a formatting diff, run `pnpm format` and re-stage the files.
- **Commits** — stage explicit paths (`git add <path>`), **never** `git add -A` (the worktree has stray untracked files). Each commit message ends EXACTLY with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
  The pre-commit hook runs a tsc build; code must typecheck.

---

### Task 1: Types + template lexicon

**Files:**
- Create: `packages/core/src/valence/types.ts`
- Create: `packages/core/src/valence/lexicons.ts`
- Test: `packages/core/src/valence/lexicons.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `Axis { readonly id: string; readonly from: string; readonly to: string }`
  - `Lexicon { readonly name: string; readonly axes: ReadonlyArray<Axis> }`
  - `AxisPosition { readonly from: string; readonly to: string; readonly z: number }` (z ∈ [0,1], 0 = `from` pole, 1 = `to` pole)
  - `EmotionalState = ReadonlyArray<AxisPosition>`
  - `AxisRange { readonly from: string; readonly to: string; readonly min: number; readonly max: number; readonly mean: number; readonly count: number }`
  - `LifetimeRange = ReadonlyArray<AxisRange>`
  - `TEMPLATE_LEXICON: Lexicon` (name `"template-v1"`, axes: joy/cry, baby/old person, city/forest, ocean/sky)

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/valence/lexicons.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { TEMPLATE_LEXICON } from "./lexicons.js"

describe("TEMPLATE_LEXICON", () => {
  it("is named template-v1 and seeds the four design axes", () => {
    expect(TEMPLATE_LEXICON.name).toBe("template-v1")
    const ids = TEMPLATE_LEXICON.axes.map((a) => a.id)
    expect(ids).toEqual(["joy-cry", "baby-old-person", "city-forest", "ocean-sky"])
  })

  it("has unique axis ids and distinct, non-empty poles", () => {
    const ids = TEMPLATE_LEXICON.axes.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const axis of TEMPLATE_LEXICON.axes) {
      expect(axis.from.length).toBeGreaterThan(0)
      expect(axis.to.length).toBeGreaterThan(0)
      expect(axis.from).not.toBe(axis.to)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest --run packages/core/src/valence/lexicons.test.ts`
Expected: FAIL — cannot resolve `./lexicons.js`.

- [ ] **Step 3: Write the types**

Create `packages/core/src/valence/types.ts`:

```ts
/**
 * A bipolar poetic axis: a pairing of two evocative poles. Emotional state is
 * read as a position between them ("on a scale from X to Y: Z").
 */
export interface Axis {
  /** Stable id, e.g. "ocean-sky". */
  readonly id: string
  /** The low pole — position 0, e.g. "ocean". */
  readonly from: string
  /** The high pole — position 1, e.g. "sky". */
  readonly to: string
}

/** A named set of axes a character is seeded with or graded against. */
export interface Lexicon {
  readonly name: string
  readonly axes: ReadonlyArray<Axis>
}

/** A position on one axis. `z` ∈ [0,1]: 0 = `from` pole, 1 = `to` pole. */
export interface AxisPosition {
  readonly from: string
  readonly to: string
  readonly z: number
}

/** A moment's emotional state: positions across one or more axes. */
export type EmotionalState = ReadonlyArray<AxisPosition>

/** Accumulated lifetime stats for a single axis. */
export interface AxisRange {
  readonly from: string
  readonly to: string
  readonly min: number
  readonly max: number
  readonly mean: number
  readonly count: number
}

/** The lifetime emotional-range record — one AxisRange per axis seen. */
export type LifetimeRange = ReadonlyArray<AxisRange>
```

- [ ] **Step 4: Write the template lexicon**

Create `packages/core/src/valence/lexicons.ts`:

```ts
import type { Lexicon } from "./types.js"

/**
 * The seed lexicon every character starts from and the stable reference that
 * eval challenges grade against (spec §4). Characters extend this with their
 * own invented axes at runtime; that personalization is out of scope here.
 */
export const TEMPLATE_LEXICON: Lexicon = {
  name: "template-v1",
  axes: [
    { id: "joy-cry", from: "joy", to: "cry" },
    { id: "baby-old-person", from: "baby", to: "old person" },
    { id: "city-forest", from: "city", to: "forest" },
    { id: "ocean-sky", from: "ocean", to: "sky" },
  ],
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest --run packages/core/src/valence/lexicons.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Lint, then commit**

Run: `pnpm check`
Expected: no errors.

```bash
git add packages/core/src/valence/types.ts packages/core/src/valence/lexicons.ts packages/core/src/valence/lexicons.test.ts
git commit -m "feat(valence): axis types + template-v1 lexicon

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Parser

**Files:**
- Create: `packages/core/src/valence/parser.ts`
- Test: `packages/core/src/valence/parser.test.ts`

**Interfaces:**
- Consumes: `AxisPosition` from `./types.js`.
- Produces:
  - `parseEmotionalState(text: string): { positions: AxisPosition[]; misses: number }` — scans free text for `"from X to Y: Z"` phrases; `Z` is a decimal (`0.7`) or percentage (`70%`), normalized and clamped to [0,1]; poles are lowercased/trimmed. `misses` = count of axis-shaped phrases whose `Z` did not parse.
  - `withinTolerance(expected: AxisPosition, actual: AxisPosition, tolerance: number): boolean` — same poles and `|z diff| ≤ tolerance`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/valence/parser.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { parseEmotionalState, withinTolerance } from "./parser.js"

describe("parseEmotionalState", () => {
  it("parses a decimal position", () => {
    const { positions, misses } = parseEmotionalState("on a scale from ocean to sky: 0.7")
    expect(positions).toEqual([{ from: "ocean", to: "sky", z: 0.7 }])
    expect(misses).toBe(0)
  })

  it("parses a percentage and normalizes to [0,1]", () => {
    const { positions } = parseEmotionalState("from joy to cry: 25%")
    expect(positions).toEqual([{ from: "joy", to: "cry", z: 0.25 }])
  })

  it("parses multiple axes and multi-word poles, lowercased", () => {
    const { positions } = parseEmotionalState(
      "I feel, on a scale from Baby to Old Person: 0.9, and from City to Forest: 10%.",
    )
    expect(positions).toEqual([
      { from: "baby", to: "old person", z: 0.9 },
      { from: "city", to: "forest", z: 0.1 },
    ])
  })

  it("clamps out-of-range values", () => {
    const { positions } = parseEmotionalState("from a to b: 150%")
    expect(positions[0].z).toBe(1)
  })

  it("counts axis-shaped phrases with unparseable Z as misses", () => {
    const { positions, misses } = parseEmotionalState("from ocean to sky: very high")
    expect(positions).toEqual([])
    expect(misses).toBe(1)
  })

  it("returns nothing for text with no axis phrases", () => {
    expect(parseEmotionalState("just a calm day")).toEqual({ positions: [], misses: 0 })
  })
})

describe("withinTolerance", () => {
  it("is true for same poles within tolerance", () => {
    expect(
      withinTolerance({ from: "ocean", to: "sky", z: 0.7 }, { from: "ocean", to: "sky", z: 0.75 }, 0.1),
    ).toBe(true)
  })

  it("is false across different poles", () => {
    expect(
      withinTolerance({ from: "ocean", to: "sky", z: 0.7 }, { from: "joy", to: "cry", z: 0.7 }, 0.5),
    ).toBe(false)
  })

  it("is false outside tolerance", () => {
    expect(
      withinTolerance({ from: "ocean", to: "sky", z: 0.1 }, { from: "ocean", to: "sky", z: 0.9 }, 0.2),
    ).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest --run packages/core/src/valence/parser.test.ts`
Expected: FAIL — cannot resolve `./parser.js`.

- [ ] **Step 3: Write the parser**

Create `packages/core/src/valence/parser.ts`:

```ts
import type { AxisPosition } from "./types.js"

/** Matches a full "from X to Y: Z" with a numeric Z (decimal or percentage). */
const POSITION_RE = /from\s+(.+?)\s+to\s+(.+?):\s*(\d+(?:\.\d+)?|\.\d+)\s*(%?)/gi

/** Matches any axis-shaped "from X to Y:" phrase, regardless of what Z is. */
const PHRASE_RE = /from\s+.+?\s+to\s+.+?:/gi

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

/**
 * Scan free text for emotional-axis positions. Poles are trimmed + lowercased;
 * Z is normalized to [0,1] (percentages divided by 100) and clamped. `misses`
 * is the number of axis-shaped phrases whose Z did not parse numerically — a
 * signal that the model emitted a malformed valence.
 */
export function parseEmotionalState(text: string): { positions: AxisPosition[]; misses: number } {
  const positions: AxisPosition[] = []
  for (const m of text.matchAll(POSITION_RE)) {
    const from = m[1].trim().toLowerCase()
    const to = m[2].trim().toLowerCase()
    const num = Number.parseFloat(m[3])
    const z = clamp01(m[4] === "%" ? num / 100 : num)
    positions.push({ from, to, z })
  }
  const phrases = [...text.matchAll(PHRASE_RE)].length
  return { positions, misses: Math.max(0, phrases - positions.length) }
}

/** True when two positions share poles and lie within `tolerance` on z. */
export function withinTolerance(
  expected: AxisPosition,
  actual: AxisPosition,
  tolerance: number,
): boolean {
  return (
    expected.from === actual.from &&
    expected.to === actual.to &&
    Math.abs(expected.z - actual.z) <= tolerance
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest --run packages/core/src/valence/parser.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Lint, then commit**

Run: `pnpm check`
Expected: no errors.

```bash
git add packages/core/src/valence/parser.ts packages/core/src/valence/parser.test.ts
git commit -m "feat(valence): parse 'from X to Y: Z' positions + tolerance compare

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Lifetime-range accumulator

**Files:**
- Create: `packages/core/src/valence/range.ts`
- Test: `packages/core/src/valence/range.test.ts`

**Interfaces:**
- Consumes: `AxisPosition`, `EmotionalState`, `AxisRange`, `LifetimeRange` from `./types.js`.
- Produces:
  - `emptyRange(): LifetimeRange` — `[]`.
  - `accumulate(range: LifetimeRange, state: EmotionalState): LifetimeRange` — folds each position into the matching `AxisRange` (by `from`+`to`), updating min/max/running-mean/count; new poles append a new `AxisRange`. Returns a new array; does not mutate the input.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/valence/range.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { emptyRange, accumulate } from "./range.js"

describe("accumulate", () => {
  it("creates an AxisRange from a first position", () => {
    const r = accumulate(emptyRange(), [{ from: "ocean", to: "sky", z: 0.6 }])
    expect(r).toEqual([{ from: "ocean", to: "sky", min: 0.6, max: 0.6, mean: 0.6, count: 1 }])
  })

  it("folds repeated positions into min/max/mean/count", () => {
    let r = emptyRange()
    r = accumulate(r, [{ from: "ocean", to: "sky", z: 0.2 }])
    r = accumulate(r, [{ from: "ocean", to: "sky", z: 0.8 }])
    r = accumulate(r, [{ from: "ocean", to: "sky", z: 0.5 }])
    expect(r).toHaveLength(1)
    expect(r[0].min).toBe(0.2)
    expect(r[0].max).toBe(0.8)
    expect(r[0].count).toBe(3)
    expect(r[0].mean).toBeCloseTo(0.5, 10)
  })

  it("tracks distinct axes independently", () => {
    const r = accumulate(emptyRange(), [
      { from: "ocean", to: "sky", z: 0.6 },
      { from: "joy", to: "cry", z: 0.1 },
    ])
    expect(r).toHaveLength(2)
    expect(r.map((a) => a.from)).toEqual(["ocean", "joy"])
  })

  it("does not mutate the input range", () => {
    const input = emptyRange()
    accumulate(input, [{ from: "city", to: "forest", z: 0.3 }])
    expect(input).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest --run packages/core/src/valence/range.test.ts`
Expected: FAIL — cannot resolve `./range.js`.

- [ ] **Step 3: Write the accumulator**

Create `packages/core/src/valence/range.ts`:

```ts
import type { AxisRange, EmotionalState, LifetimeRange } from "./types.js"

/** An empty lifetime emotional-range record. */
export function emptyRange(): LifetimeRange {
  return []
}

/**
 * Fold a moment's emotional state into the lifetime record. Each position
 * updates its axis's min/max, running mean, and count; unseen poles append a
 * fresh AxisRange. Returns a new array — the input is never mutated.
 */
export function accumulate(range: LifetimeRange, state: EmotionalState): LifetimeRange {
  const next: AxisRange[] = range.map((r) => ({ ...r }))
  for (const pos of state) {
    const i = next.findIndex((r) => r.from === pos.from && r.to === pos.to)
    if (i === -1) {
      next.push({ from: pos.from, to: pos.to, min: pos.z, max: pos.z, mean: pos.z, count: 1 })
    } else {
      const prev = next[i]
      const count = prev.count + 1
      next[i] = {
        from: prev.from,
        to: prev.to,
        min: Math.min(prev.min, pos.z),
        max: Math.max(prev.max, pos.z),
        mean: prev.mean + (pos.z - prev.mean) / count,
        count,
      }
    }
  }
  return next
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest --run packages/core/src/valence/range.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Lint, then commit**

Run: `pnpm check`
Expected: no errors.

```bash
git add packages/core/src/valence/range.ts packages/core/src/valence/range.test.ts
git commit -m "feat(valence): lifetime emotional-range accumulator

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Narrativizer

**Files:**
- Create: `packages/core/src/valence/narrate.ts`
- Test: `packages/core/src/valence/narrate.test.ts`

**Interfaces:**
- Consumes: `AxisRange`, `LifetimeRange` from `./types.js`.
- Produces:
  - `narrate(range: LifetimeRange): string` — a deterministic poetic summary. Empty → a fixed "nothing yet" line. Per axis: mean < 0.4 → "nearer the {from}"; mean > 0.6 → "nearer the {to}"; else "between {from} and {to}"; a span (max − min) > 0.5 appends ", ranging widely from {from} to {to}". One sentence per axis, space-joined.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/valence/narrate.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { narrate } from "./narrate.js"

describe("narrate", () => {
  it("reports nothing for an empty range", () => {
    expect(narrate([])).toBe("I have not yet felt anything worth remembering.")
  })

  it("dwells nearer the low pole when mean is low", () => {
    const s = narrate([{ from: "ocean", to: "sky", min: 0.1, max: 0.3, mean: 0.2, count: 4 }])
    expect(s).toBe("Lately I have lived nearer the ocean.")
  })

  it("dwells nearer the high pole when mean is high", () => {
    const s = narrate([{ from: "ocean", to: "sky", min: 0.7, max: 0.8, mean: 0.75, count: 2 }])
    expect(s).toBe("Lately I have lived nearer the sky.")
  })

  it("notes a wide span", () => {
    const s = narrate([{ from: "joy", to: "cry", min: 0.1, max: 0.9, mean: 0.2, count: 5 }])
    expect(s).toBe("Lately I have lived nearer the joy, ranging widely from joy to cry.")
  })

  it("joins one sentence per axis", () => {
    const s = narrate([
      { from: "ocean", to: "sky", min: 0.2, max: 0.2, mean: 0.2, count: 1 },
      { from: "city", to: "forest", min: 0.5, max: 0.5, mean: 0.5, count: 1 },
    ])
    expect(s).toBe(
      "Lately I have lived nearer the ocean. Lately I have lived between city and forest.",
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest --run packages/core/src/valence/narrate.test.ts`
Expected: FAIL — cannot resolve `./narrate.js`.

- [ ] **Step 3: Write the narrativizer**

Create `packages/core/src/valence/narrate.ts`:

```ts
import type { AxisRange, LifetimeRange } from "./types.js"

function axisLine(r: AxisRange): string {
  const dwelt =
    r.mean < 0.4 ? `nearer the ${r.from}` : r.mean > 0.6 ? `nearer the ${r.to}` : `between ${r.from} and ${r.to}`
  const reach = r.max - r.min > 0.5 ? `, ranging widely from ${r.from} to ${r.to}` : ""
  return `Lately I have lived ${dwelt}${reach}.`
}

/**
 * A deterministic poetic summary of the lifetime emotional range, phrased in
 * the character's own axis vocabulary. The dream cycle will fold this into the
 * diary; that wiring is a later plan.
 */
export function narrate(range: LifetimeRange): string {
  if (range.length === 0) return "I have not yet felt anything worth remembering."
  return range.map(axisLine).join(" ")
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest --run packages/core/src/valence/narrate.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Lint, then commit**

Run: `pnpm check`
Expected: no errors.

```bash
git add packages/core/src/valence/narrate.ts packages/core/src/valence/narrate.test.ts
git commit -m "feat(valence): deterministic lifetime-range narrativizer

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Barrel + package export + end-to-end pipeline test

**Files:**
- Create: `packages/core/src/valence/index.ts`
- Modify: `packages/core/src/index.ts` (append one export block)
- Test: `packages/core/src/valence/pipeline.test.ts`

**Interfaces:**
- Consumes: every public symbol from Tasks 1–4.
- Produces: the `valence` barrel re-exporting all public types + functions, surfaced from `@roci/core` via `packages/core/src/index.ts`. This is what the challenge-generators plan (B) imports.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/valence/pipeline.test.ts` — an end-to-end check that the pieces compose through the barrel:

```ts
import { describe, it, expect } from "vitest"
import { parseEmotionalState, emptyRange, accumulate, narrate, TEMPLATE_LEXICON } from "./index.js"

describe("valence pipeline (via barrel)", () => {
  it("parses transcripts, accumulates a range, and narrates it", () => {
    const transcripts = [
      "today, on a scale from ocean to sky: 0.2",
      "now from ocean to sky: 0.8 and from joy to cry: 10%",
    ]
    let range = emptyRange()
    for (const t of transcripts) {
      range = accumulate(range, parseEmotionalState(t).positions)
    }
    const ocean = range.find((r) => r.from === "ocean")
    expect(ocean).toBeDefined()
    expect(ocean?.count).toBe(2)
    expect(ocean?.min).toBe(0.2)
    expect(ocean?.max).toBe(0.8)
    expect(narrate(range)).toContain("ranging widely from ocean to sky")
  })

  it("re-exports the template lexicon", () => {
    expect(TEMPLATE_LEXICON.name).toBe("template-v1")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest --run packages/core/src/valence/pipeline.test.ts`
Expected: FAIL — cannot resolve `./index.js`.

- [ ] **Step 3: Write the barrel**

Create `packages/core/src/valence/index.ts`:

```ts
export type {
  Axis,
  AxisPosition,
  AxisRange,
  EmotionalState,
  Lexicon,
  LifetimeRange,
} from "./types.js"
export { TEMPLATE_LEXICON } from "./lexicons.js"
export { parseEmotionalState, withinTolerance } from "./parser.js"
export { emptyRange, accumulate } from "./range.js"
export { narrate } from "./narrate.js"
```

- [ ] **Step 4: Surface from the package root**

Append to `packages/core/src/index.ts` (this file uses **tab** indentation — match it). Add at the end of the file:

```ts
// Valence — emotional-axis encoding, lifetime range, narrativization
export type {
	Axis,
	AxisPosition,
	AxisRange,
	EmotionalState,
	Lexicon,
	LifetimeRange,
} from "./valence/index.js";
export {
	TEMPLATE_LEXICON,
	accumulate,
	emptyRange,
	narrate,
	parseEmotionalState,
	withinTolerance,
} from "./valence/index.js";
```

- [ ] **Step 5: Run the test + the full suite + typecheck**

Run: `pnpm vitest --run packages/core/src/valence/pipeline.test.ts`
Expected: PASS (2 tests).

Run: `pnpm test`
Expected: the whole suite passes, including the 22 new valence tests; no regressions.

Run: `pnpm typecheck`
Expected: clean (confirms the `packages/core/src/index.ts` edit typechecks).

- [ ] **Step 6: Lint, then commit**

Run: `pnpm check`
Expected: no errors.

```bash
git add packages/core/src/valence/index.ts packages/core/src/valence/pipeline.test.ts packages/core/src/index.ts
git commit -m "feat(valence): barrel + package export + end-to-end pipeline test

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## What this plan deliberately does NOT do (next plans)

- **Live integration (plan A2):** change `ObserveResult.emotionalWeight` / `OrientResult.emotionalState` to carry parsed positions, accumulate the lifetime range inside the cortex loop, and call `narrate` from `dream.ts`.
- **Personal-axis invention/storage:** persisting a character's invented axes against its identity files, and the internal-consistency check over them.
- **Challenge generators (plan B):** the social/financial/delegation/synthesis/triage generators that consume `withinTolerance` + the template lexicon for grading.
- **System prompts (plan C):** the per-callsite system prompt that teaches the `"from X to Y: Z"` format.
