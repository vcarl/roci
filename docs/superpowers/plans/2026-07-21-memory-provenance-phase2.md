# Memory Provenance & Salience — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every character a model-authored **salience profile** — a reviewed `SALIENCE.md` weighting how strongly this character reacts to each stimulus dimension (the core drives + domain drive as a fixed spine, plus up to 2 model-named extras) — generated at scaffold time through the existing operator review loop, parseable host-side.

**Architecture:** Salience is the structural sibling of `PALETTE.md` (how a character *feels*) and `DRIVES.md` (what a character *cares about*). A new pure `core/salience.ts` module carries the artifact template, file wrapper, render helper, and a regex parser that mirrors `parseDriveNames`. A new `salience` `IdentityStep` + `buildSaliencePrompt` (sibling to `buildDrivesPrompt`) runs inside `scaffoldCharacter` **after `drives`** — depending on the approved drives spine + values + background — through the same `runStep` accept/regenerate/skip loop. `CharacterFs.readSalience` reads the file with a `TEMPLATE_SALIENCE` graceful-degradation default so pre-existing characters still degrade sanely.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Effect-TS (`Context`/`Layer`, `@effect/platform` `FileSystem`), vitest.

**Scope note — this is Phase 2 of 3** (see `docs/superpowers/specs/2026-07-21-memory-provenance-salience-design.md` §7). Phase 2 = the character salience profile, an **identity-generation artifact only**. It has **no** dependency on the memory-ranking module and does not touch it — per-memory salience signatures and salience-decay ranking are **Phase 3** (already scoped separately). Phase 2 is independently shippable and testable. Ranking consumes this profile in Phase 3.

## Global Constraints

- **Base branch:** `feat/memory-provenance` (forked from `main` 65fa41c). Work in the worktree `/Users/vcarl/workspace/roci/.claude/worktrees/memory-provenance`. Paths below are relative to that worktree root.
- **ESM imports:** every relative import specifier ends in `.js`. Effect-TS service/layer patterns as in the surrounding code (`CharacterFs`, `ModelService`).
- **Phase 2 is identity-gen ONLY:** it must introduce **no** dependency on `packages/core/src/brain/limbic/hippocampus/memory/*`. (Ranking consumes the profile in Phase 3.) A *type-only* import of `DomainDrive` from `#brain/limbic/hypothalamus/drives.js` is allowed and matches the established pattern (`character-scaffold.ts` and `CharacterFs.ts` already import from that subpath) — `hypothalamus/drives` is NOT the memory module.
- **`SALIENCE.md` line format (exact):** `- <dimension>: <0.0-1.0>  # <gloss>`. `parseSalience` clamps scores to `[0,1]`, drops malformed/unknown lines, and mirrors `parseDriveNames`'s regex-parse approach.
- **`TEMPLATE_SALIENCE` (the readSalience fallback):** the core drive spine (`safety`/`sustenance`/`agency`) at neutral **0.5**, zero extras — mirroring `TEMPLATE_DRIVES` (core-only). It MUST itself parse cleanly through `parseSalience`. The domain drive is added at scaffold time by `renderSalienceLines(domainDrives)` (mirroring how `renderDriveLines(domainDrives)` adds the domain drive to the core `TEMPLATE_DRIVES`), so every scaffolded `SALIENCE.md` carries the domain drive. See the *Resolved ambiguity* note at the end.
- **Spine = core drives (`safety`/`sustenance`/`agency`) + the single domain drive; extras = 0–2 model-named dimensions.**
- **Step order:** the `salience` step runs **after `drives`** in `scaffoldCharacter`, via the existing `runStep` operator accept/regenerate/skip loop; `SALIENCE.md` is written where the other `me/*.md` files are.
- **Do NOT touch:** `brain/limbic/hippocampus/memory/*` (the memory module), `macro.ts` / the `{{synthesis}}` surface, prompt-template prose (`skills/*.md`), or any ranking/decay code.
- **Test command (single file):** `pnpm vitest --run <path>` (from the worktree root). **Typecheck (no cache):** `pnpm nx run @roci/core:typecheck --skip-nx-cache`.
- **Every commit is green:** each task ends with its own tests passing AND `@roci/core` typechecking (tests included). The pre-commit hook runs a full nx build; do not use `--no-verify`.
- **Commits:** conventional-commit style; end the body with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

**New files**
- `packages/core/src/core/salience.ts` — `TEMPLATE_SALIENCE`, `renderSalienceLines`, `salienceFile`, `parseSalience`. The pure salience-artifact module, sibling to `core/palette.ts`. (Task 1)
- `packages/core/src/core/salience.test.ts` (Task 1)

**Modified files**
- `packages/core/src/core/identity-gen/prompts.ts` — add `"salience"` to `IdentityStep`, `buildSaliencePrompt`, the `promptForStep` case. (Task 2)
- `packages/core/src/core/identity-gen/prompts.test.ts` (Task 2)
- `packages/core/src/services/CharacterFs.ts` — `readSalience` (interface + Live impl), `TEMPLATE_SALIENCE` import + fallback. (Task 3)
- `packages/core/src/services/CharacterFs.test.ts` (Task 3)
- **7 test files with inline `CharacterFs.of` fakes** — each gains a one-line `readSalience` fake because the interface is structural (Task 3, Step 6): `core/orchestrator/planned-action.test.ts`, `brain/stem/loop.test.ts` (×5), `brain/limbic/hippocampus/{retrospect,identity-context,dream,macro,synthesis-bootstrap}.test.ts`.
- `packages/core/src/core/character-scaffold.ts` — import `renderSalienceLines`/`salienceFile`; default `salienceBody`; thread approved drives into `ctx.baseDrives`; run the `salience` step after `drives`; write `SALIENCE.md`. (Task 4)
- `packages/core/src/core/character-scaffold.test.ts` (Task 4)

**Task order (each commit green):** Task 1 (`salience.ts` pure module — no deps) → Task 2 (`prompts.ts` builder + step — no deps on Task 1) → Task 3 (`CharacterFs.readSalience` — consumes `TEMPLATE_SALIENCE` from Task 1) → Task 4 (`scaffoldCharacter` wiring — consumes `renderSalienceLines`/`salienceFile` from Task 1 + the `"salience"` `IdentityStep` from Task 2). Task 2 is independent of Task 1; Task 3 depends on Task 1; Task 4 depends on Tasks 1 and 2.

---

### Task 1: Salience artifact module (pure) — template, render, wrapper, parse

**Files:**
- Create: `packages/core/src/core/salience.ts`
- Test: `packages/core/src/core/salience.test.ts`

**Interfaces:**
- Consumes: `type DomainDrive` from `#brain/limbic/hypothalamus/drives.js` (type-only — `{ readonly name: string; readonly description: string }`).
- Produces:
  - `const TEMPLATE_SALIENCE: string` — the core-drive spine at 0.5 (the `readSalience` fallback).
  - `function renderSalienceLines(domainDrives?: ReadonlyArray<DomainDrive>): string` — core spine + one `- <name>: 0.5  # …` row per domain drive (mirrors `renderDriveLines`).
  - `function salienceFile(body: string): string` — wraps a body in the `# Salience` header (mirrors `paletteFile`/`drivesFile`).
  - `function parseSalience(md: string): Record<string, number>` — one well-formed line → `{ dimension: score }`, score clamped to `[0,1]`, malformed/unknown lines dropped (mirrors `parseDriveNames`).

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/core/salience.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { TEMPLATE_SALIENCE, renderSalienceLines, salienceFile, parseSalience } from "./salience.js"

// The canonical §2 example (design 2026-07-21): core spine + domain drive + 1 extra.
const EXAMPLE = `- safety: 0.9        # she flinches at every threat; danger dominates her attention
- sustenance: 0.4    # resource pressure barely registers until it's dire
- agency: 0.7        # being blocked or controlled cuts deep
- voyage: 0.3        # the mission is a means, not a hunger
- reputation: 0.8    # (extra) how others see her is load-bearing to her identity`

const CORE = ["safety", "sustenance", "agency"]

describe("parseSalience", () => {
  it("maps each well-formed line to its clamped score", () => {
    expect(parseSalience(EXAMPLE)).toEqual({
      safety: 0.9, sustenance: 0.4, agency: 0.7, voyage: 0.3, reputation: 0.8,
    })
  })

  it("clamps scores to [0,1]", () => {
    const md = "- safety: 1.5  # over\n- agency: -0.2  # under\n- sustenance: 0  # floor"
    expect(parseSalience(md)).toEqual({ safety: 1, agency: 0, sustenance: 0 })
  })

  it("drops malformed / non-dimension lines", () => {
    const md = [
      "# Salience",                        // header — dropped
      "not a salience line at all",        // prose — dropped
      "- safety 0.5  # missing colon",     // no colon — dropped
      "- broken: notanumber  # NaN score", // non-numeric — dropped
      "- agency: 0.6  # kept",             // valid — kept
    ].join("\n")
    expect(parseSalience(md)).toEqual({ agency: 0.6 })
  })

  it("the §2 example has all core + domain dims present and ≤2 extras", () => {
    const parsed = parseSalience(EXAMPLE)
    for (const d of CORE) expect(parsed).toHaveProperty(d)
    expect(parsed).toHaveProperty("voyage") // domain drive
    const extras = Object.keys(parsed).filter((k) => !CORE.includes(k) && k !== "voyage")
    expect(extras.length).toBeLessThanOrEqual(2)
  })
})

describe("TEMPLATE_SALIENCE", () => {
  it("parses cleanly to the core spine at neutral 0.5, no extras", () => {
    expect(parseSalience(TEMPLATE_SALIENCE)).toEqual({
      safety: 0.5, sustenance: 0.5, agency: 0.5,
    })
  })
})

describe("renderSalienceLines", () => {
  it("returns the core-only template when there are no domain drives", () => {
    expect(renderSalienceLines()).toBe(TEMPLATE_SALIENCE)
    expect(renderSalienceLines([])).toBe(TEMPLATE_SALIENCE)
  })

  it("appends a neutral 0.5 row per domain drive, parseable alongside the core spine", () => {
    const out = renderSalienceLines([{ name: "voyage", description: "reach the next system" }])
    expect(out).toContain("- voyage: 0.5")
    expect(parseSalience(out)).toEqual({
      safety: 0.5, sustenance: 0.5, agency: 0.5, voyage: 0.5,
    })
  })
})

describe("salienceFile", () => {
  it("wraps a body under the # Salience header and stays parseable", () => {
    const out = salienceFile(TEMPLATE_SALIENCE)
    expect(out.startsWith("# Salience")).toBe(true)
    expect(out.toLowerCase()).toContain("0.0")
    // The header/comment lines must not leak into the parse.
    expect(parseSalience(out)).toEqual({ safety: 0.5, sustenance: 0.5, agency: 0.5 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest --run packages/core/src/core/salience.test.ts`
Expected: FAIL — cannot resolve `./salience.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/core/salience.ts`:

```ts
/**
 * The salience profile — HOW STRONGLY this character reacts to each kind of
 * stimulus. The structural sibling of `palette.ts` (how a character *feels*) and
 * `drives.ts` (what a character *cares about*): salience is a weight per stimulus
 * dimension. Dimensions are the drive taxonomy as a fixed spine (the 3 core
 * drives + the one domain drive) plus up to 2 model-named character-specific
 * extras. Characters get a personalized profile generated at creation time
 * (identity-gen); this module holds the artifact template, file wrapper, render
 * helper, and the host-side parser. (design 2026-07-21 §2.)
 *
 * Phase 2 is identity-gen ONLY — this module has no dependency on the memory
 * module. Phase 3's ranking loads the parsed profile and uses it as a decay knob.
 */

import type { DomainDrive } from "#brain/limbic/hypothalamus/drives.js"

/**
 * Graceful-degradation default: the 3 core drives at a neutral 0.5, no extras —
 * so a character created before this identity-gen step still ranks sanely. Core
 * only, exactly mirroring `TEMPLATE_DRIVES`; the domain drive is added at scaffold
 * time by `renderSalienceLines(domainDrives)`. Keep the `- <dim>: <n>  # <gloss>`
 * line format so it round-trips through `parseSalience`.
 */
export const TEMPLATE_SALIENCE = `- safety: 0.5        # neutral default weighting — no personalized profile yet
- sustenance: 0.5    # neutral default weighting — no personalized profile yet
- agency: 0.5        # neutral default weighting — no personalized profile yet`

/**
 * Render the default salience spine: the 3 core drives, then one neutral 0.5 row
 * per domain drive. Mirrors `renderDriveLines(domainDrives)` — this is the
 * scaffold default a character starts from (and what an operator skip falls back
 * to) before the model personalizes the weights.
 */
export function renderSalienceLines(domainDrives?: ReadonlyArray<DomainDrive>): string {
  if (!domainDrives || domainDrives.length === 0) return TEMPLATE_SALIENCE
  const rows = domainDrives
    .map((d) => `- ${d.name}: 0.5  # neutral default weighting — no personalized profile yet`)
    .join("\n")
  return `${TEMPLATE_SALIENCE}\n${rows}`
}

/** Wrap a salience body in the human-readable SALIENCE.md file header (mirror paletteFile/drivesFile). */
export const salienceFile = (body: string): string =>
  `# Salience
<!-- How strongly this character reacts to each kind of stimulus — a weight per
     dimension. The first lines are the core drives + this domain's drive (the
     fixed spine); any extra lines are character-specific. Scores run 0.0 (barely
     registers) to 1.0 (dominates attention). Later drives a memory's decay rate. -->

${body.trim()}
`

/**
 * Parse a SALIENCE.md body into `{ dimension: score }`. Mirrors `parseDriveNames`'
 * regex approach: one `- <dimension>: <number>  # <gloss>` line → one entry;
 * scores clamped to [0,1]; malformed / non-dimension lines dropped. The optional
 * leading sign lets a stray negative clamp to 0 rather than silently drop.
 */
export function parseSalience(md: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of md.split("\n")) {
    const m = line.match(/^-\s*([A-Za-z][\w-]*)\s*:\s*([-+]?[0-9]*\.?[0-9]+)/)
    if (!m) continue
    const n = Number(m[2])
    if (!Number.isFinite(n)) continue
    out[m[1].toLowerCase()] = Math.min(1, Math.max(0, n))
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest --run packages/core/src/core/salience.test.ts`
Expected: PASS (all describes).

- [ ] **Step 5: Typecheck**

Run: `pnpm nx run @roci/core:typecheck --skip-nx-cache`
Expected: SUCCESS. Confirms the type-only `DomainDrive` import from `#brain/limbic/hypothalamus/drives.js` resolves under the `#brain/*` subpath alias.

- [ ] **Step 6: Commit**

```bash
cd /Users/vcarl/workspace/roci/.claude/worktrees/memory-provenance
git add packages/core/src/core/salience.ts packages/core/src/core/salience.test.ts
git commit -m "feat(identity): salience artifact module — template, render, wrapper, parse

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `salience` identity step + `buildSaliencePrompt`

**Files:**
- Modify: `packages/core/src/core/identity-gen/prompts.ts` (`IdentityStep` line 1; add `buildSaliencePrompt` after `buildDrivesPrompt` ~line 73; `promptForStep` switch ~lines 105-120)
- Test: `packages/core/src/core/identity-gen/prompts.test.ts`

**Interfaces:**
- Consumes: `IdentityContext` (existing — `buildSaliencePrompt` reads `characterName`, `background`, `values`, `baseDrives`, `feedback`).
- Produces:
  - `type IdentityStep` gains the `"salience"` member.
  - `function buildSaliencePrompt(ctx: IdentityContext): string`.
  - `promptForStep("salience", ctx)` returns `buildSaliencePrompt(ctx)`.

- [ ] **Step 1: Write the failing test**

Add `buildSaliencePrompt` to the import block at the top of `packages/core/src/core/identity-gen/prompts.test.ts`:

```ts
import {
  buildBackgroundPrompt,
  buildValuesPrompt,
  buildPalettePrompt,
  buildDrivesPrompt,
  buildSaliencePrompt,
  buildDiaryPrompt,
  buildSummaryPrompt,
  promptForStep,
  type IdentityContext,
} from "./prompts.js"
```

Add this test inside the `describe("prompt builders", …)` block (e.g. after the `drives prompt …` test):

```ts
  it("salience prompt threads drives + values + background and demands the weight line format", () => {
    const p = buildSaliencePrompt({ ...base, background: "BG", values: "VAL", baseDrives: "- safety — DRIVE-MARKER" })
    expect(p).toContain("DRIVE-MARKER") // the approved drive spine
    expect(p).toContain("VAL")
    expect(p).toContain("BG")
    expect(p).toContain("0.0")
    expect(p).toContain("1.0")
    expect(p).toContain("- <dimension>: <0.0-1.0>  # <short gloss in the character's voice>")
    expect(p.toLowerCase()).toContain("up to 2")
    expect(p.toLowerCase()).toContain("do not rename")
  })

  it("salience prompt appends operator feedback when present", () => {
    const p = buildSaliencePrompt({ ...base, background: "BG", values: "VAL", feedback: "make her jumpier" })
    expect(p).toContain("make her jumpier")
  })
```

Extend the existing `promptForStep dispatches by step` test with a salience assertion:

```ts
  it("promptForStep dispatches by step", () => {
    expect(promptForStep("background", base)).toBe(buildBackgroundPrompt(base))
    expect(promptForStep("diary", { ...base, values: "VAL" })).toContain("VAL")
    const sal = { ...base, baseDrives: "- safety — X" }
    expect(promptForStep("salience", sal)).toBe(buildSaliencePrompt(sal))
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest --run packages/core/src/core/identity-gen/prompts.test.ts`
Expected: FAIL — `buildSaliencePrompt` is not exported.

- [ ] **Step 3: Add `"salience"` to the `IdentityStep` union**

In `packages/core/src/core/identity-gen/prompts.ts`, replace line 1:

```ts
export type IdentityStep = "background" | "values" | "palette" | "drives" | "diary" | "summary"
```

with:

```ts
export type IdentityStep = "background" | "values" | "palette" | "drives" | "salience" | "diary" | "summary"
```

- [ ] **Step 4: Add `buildSaliencePrompt`**

Insert this function immediately after `buildDrivesPrompt` (after its closing `}` ~line 73), before `buildDiaryPrompt`:

```ts
export const buildSaliencePrompt = (ctx: IdentityContext): string => {
  return `You are authoring the SALIENCE profile for an AI character named "${ctx.characterName}".

Approved background:
${ctx.background ?? "(none)"}

Approved values:
${ctx.values ?? "(none)"}

Here are this character's drives — the reference frame every event is weighed against. The FIRST three (safety, sustenance, agency) are universal core drives; any below them are domain-specific:
${ctx.baseDrives ?? "(none)"}
${feedbackBlock(ctx)}
Salience is HOW STRONGLY this character reacts to each kind of stimulus. For EVERY drive above (keep every drive NAME exactly — do not rename, add, or drop them), assign a weight reflecting THIS character's psyche from the background and values above. Then you MAY add up to 2 extra character-specific dimensions that capture something the drives miss (e.g. reputation, curiosity). Weights run from 0.0 (barely registers) to 1.0 (dominates their attention).

Use EXACTLY this line format, one dimension per line:
- <dimension>: <0.0-1.0>  # <short gloss in the character's voice>

Output ONLY the salience lines, no commentary.`
}
```

- [ ] **Step 5: Add the `promptForStep` case**

In the `promptForStep` switch, add a `salience` case between `drives` and `diary`:

```ts
    case "drives":
      return buildDrivesPrompt(ctx)
    case "salience":
      return buildSaliencePrompt(ctx)
    case "diary":
      return buildDiaryPrompt(ctx)
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm vitest --run packages/core/src/core/identity-gen/prompts.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `pnpm nx run @roci/core:typecheck --skip-nx-cache`
Expected: SUCCESS. The new `IdentityStep` member is exhaustively handled by the `promptForStep` switch (which returns `string` on every path) and by `character-scaffold.ts`'s `runStep` (Task 4 not yet wired, but `runStep` accepts any `IdentityStep`, so no unhandled-case error surfaces here).

- [ ] **Step 8: Commit**

```bash
cd /Users/vcarl/workspace/roci/.claude/worktrees/memory-provenance
git add packages/core/src/core/identity-gen/prompts.ts packages/core/src/core/identity-gen/prompts.test.ts
git commit -m "feat(identity): salience IdentityStep + buildSaliencePrompt

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `CharacterFs.readSalience` (with template fallback)

**Files:**
- Modify: `packages/core/src/services/CharacterFs.ts` (import ~line 4-5; interface ~line 60; Live impl ~line 137-138)
- Test: `packages/core/src/services/CharacterFs.test.ts`

**Interfaces:**
- Consumes: `TEMPLATE_SALIENCE`, `parseSalience` (Task 1).
- Produces: `CharacterFs` gains `readonly readSalience: (char: CharacterConfig) => Effect.Effect<string, CharacterFsError>` — returns the raw `SALIENCE.md` string, or `TEMPLATE_SALIENCE` when the file is absent/unreadable. (Consumers parse it via `parseSalience`; keeping `CharacterFs` I/O-only mirrors `readDrives`/`readPalette`.)

- [ ] **Step 1: Write the failing test**

Add this import near the top of `packages/core/src/services/CharacterFs.test.ts` (below the `skills-core.js` import):

```ts
import { parseSalience, TEMPLATE_SALIENCE } from "../core/salience.js"
```

Append this describe block to `packages/core/src/services/CharacterFs.test.ts`:

```ts
describe("CharacterFs.readSalience (Phase 2 salience profile)", () => {
  it("falls back to TEMPLATE_SALIENCE when SALIENCE.md is absent", async () => {
    const md = await run(Effect.flatMap(CharacterFs, (s) => s.readSalience(char)))
    expect(md).toBe(TEMPLATE_SALIENCE)
    // the default degrades to the core drive spine at neutral 0.5
    expect(parseSalience(md)).toEqual({ safety: 0.5, sustenance: 0.5, agency: 0.5 })
  })

  it("reads a written SALIENCE.md verbatim", async () => {
    fs.mkdirSync(char.dir, { recursive: true })
    const body = "- safety: 0.9  # jumpy\n- sustenance: 0.4  # steady\n- agency: 0.7  # willful"
    fs.writeFileSync(path.join(char.dir, "SALIENCE.md"), body)
    const md = await run(Effect.flatMap(CharacterFs, (s) => s.readSalience(char)))
    expect(md).toBe(body)
    expect(parseSalience(md)).toEqual({ safety: 0.9, sustenance: 0.4, agency: 0.7 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest --run packages/core/src/services/CharacterFs.test.ts`
Expected: FAIL — `readSalience` does not exist on the `CharacterFs` service (and `../core/salience.js` may resolve but the property is missing).

- [ ] **Step 3: Import `TEMPLATE_SALIENCE`**

In `packages/core/src/services/CharacterFs.ts`, replace:

```ts
import { TEMPLATE_PALETTE } from "../core/palette.js"
import { TEMPLATE_DRIVES } from "#brain/limbic/hypothalamus/drives.js"
```

with:

```ts
import { TEMPLATE_PALETTE } from "../core/palette.js"
import { TEMPLATE_SALIENCE } from "../core/salience.js"
import { TEMPLATE_DRIVES } from "#brain/limbic/hypothalamus/drives.js"
```

- [ ] **Step 4: Add `readSalience` to the service interface**

In the `CharacterFs extends Context.Tag(...)` interface, add the `readSalience` line immediately after `readDrives`:

```ts
    readonly readDrives: (char: CharacterConfig) => Effect.Effect<string, CharacterFsError>
    readonly readSalience: (char: CharacterConfig) => Effect.Effect<string, CharacterFsError>
```

- [ ] **Step 5: Add the `readSalience` implementation**

In the `CharacterFs.of({ … })` Live implementation, add `readSalience` immediately after the `readDrives` implementation:

```ts
      readDrives: (char) =>
        readFileOr(path.join(char.dir, "DRIVES.md"), TEMPLATE_DRIVES),

      readSalience: (char) =>
        readFileOr(path.join(char.dir, "SALIENCE.md"), TEMPLATE_SALIENCE),
```

- [ ] **Step 6: Update every inline `CharacterFs.of` test fake**

`CharacterFs` is a `Context.Tag` — its interface is structural, so adding `readSalience` means **every** `CharacterFs.of({...})` construction must now supply it or `tsc` fails with `Property 'readSalience' is missing`. There is **no shared fake helper**; the fakes are inlined at these sites (verified against the tree). In each, add a `readSalience` line immediately next to the existing `readDrives: () => Effect.succeed(""),` line, matching the sibling's empty-string fake (no new import needed — the tests don't assert on salience content):

```ts
      readDrives: () => Effect.succeed(""),
      readSalience: () => Effect.succeed(""),
```

Sites to update (do NOT weaken the interface to make these optional):
- `packages/core/src/core/orchestrator/planned-action.test.ts` (1 fake, ~L82)
- `packages/core/src/brain/stem/loop.test.ts` (**5** fakes: ~L176, L204, L606, L828, L3384)
- `packages/core/src/brain/limbic/hippocampus/retrospect.test.ts` (1 fake, ~L37)
- `packages/core/src/brain/limbic/hippocampus/identity-context.test.ts` (1 fake, ~L26)
- `packages/core/src/brain/limbic/hippocampus/dream.test.ts` (1 fake, ~L63)
- `packages/core/src/brain/limbic/hippocampus/macro.test.ts` (1 fake, ~L58)
- `packages/core/src/brain/limbic/hippocampus/synthesis-bootstrap.test.ts` (1 fake, ~L40)

The `--skip-nx-cache` typecheck in Step 8 is the backstop: it enumerates any site missed here by file:line. Before editing, re-confirm the list is current:

```bash
cd /Users/vcarl/workspace/roci/.claude/worktrees/memory-provenance
grep -rn "readDrives:" packages/core/src --include="*.ts" | grep -v "CharacterFs.ts"
```

Every line it prints needs the adjacent `readSalience` fake.

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm vitest --run packages/core/src/services/CharacterFs.test.ts`
Expected: PASS (existing suites + the two new `readSalience` cases).

- [ ] **Step 8: Typecheck (whole package — catches every fake)**

Run: `pnpm nx run @roci/core:typecheck --skip-nx-cache`
Expected: SUCCESS. This compiles the test files too, so any `CharacterFs.of` fake still missing `readSalience` fails here with its exact file:line — add the line (Step 6) and re-run until green. Do NOT make `readSalience` optional to silence it.

- [ ] **Step 9: Commit**

```bash
cd /Users/vcarl/workspace/roci/.claude/worktrees/memory-provenance
git add packages/core/src/services/CharacterFs.ts packages/core/src/services/CharacterFs.test.ts \
  packages/core/src/core/orchestrator/planned-action.test.ts \
  packages/core/src/brain/stem/loop.test.ts \
  packages/core/src/brain/limbic/hippocampus/retrospect.test.ts \
  packages/core/src/brain/limbic/hippocampus/identity-context.test.ts \
  packages/core/src/brain/limbic/hippocampus/dream.test.ts \
  packages/core/src/brain/limbic/hippocampus/macro.test.ts \
  packages/core/src/brain/limbic/hippocampus/synthesis-bootstrap.test.ts
git commit -m "feat(identity): CharacterFs.readSalience with TEMPLATE_SALIENCE fallback

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Wire the `salience` step into `scaffoldCharacter`

Lands the scaffold change as one green commit: the import, the default `salienceBody`, threading the approved drive spine into `ctx.baseDrives`, running the `salience` step after `drives`, and writing `SALIENCE.md` are one cohesive change with one test rewrite.

**Files:**
- Modify: `packages/core/src/core/character-scaffold.ts` (imports ~line 10-11; doc comment ~line 82; defaults ~line 122-123; step sequence ~line 149-152; files array ~line 161-168)
- Test: `packages/core/src/core/character-scaffold.test.ts`

**Interfaces:**
- Consumes: `renderSalienceLines`, `salienceFile` (Task 1); the `"salience"` `IdentityStep` (Task 2); existing `runStep`, `renderDriveLines`, `drivesFile`.
- Produces: `scaffoldCharacter` writes `players/<name>/me/SALIENCE.md` alongside the other `me/*.md` files. The generation order is now background → values → palette → drives → **salience** → diary → summary. External signature unchanged.

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/core/character-scaffold.test.ts`, add a `SALIENCE.md` assertion to the existing `merges the domain's domainDrives into DRIVES.md …` test (append after the DRIVES.md assertions, before the test's closing `})`):

```ts
    // The salience spine mirrors the drive spine: core + the domain drive at neutral 0.5.
    const salience = readFileSync(path.join(meDir("merged"), "SALIENCE.md"), "utf-8")
    expect(salience.startsWith("# Salience")).toBe(true)
    expect(salience).toContain("- safety: 0.5")
    expect(salience).toContain("- voyage: 0.5")
```

Add a `SALIENCE.md` assertion to the existing `with a description generates each artifact and accepts them` test (append before its closing `})`):

```ts
    const salience = readFileSync(path.join(meDir("gen"), "SALIENCE.md"), "utf-8")
    expect(salience).toContain("GEN:") // the model-authored salience body was written
```

Update the existing `regenerate threads feedback then accept; skip writes template` test — the step order gained `salience` between `drives` and `diary`, so insert a salience decision into the scripted queue. Replace the `scriptedReview([...])` array in that test with:

```ts
    const review = scriptedReview([
      { action: "regenerate", feedback: "grimmer" },        // background: re-roll once
      { action: "accept", content: "BG-OK" },               // background: accept edited
      { action: "accept", content: "VAL-OK" },              // values
      { action: "skip" },                                    // palette → TEMPLATE_PALETTE
      { action: "skip" },                                    // drives → core+domain template
      { action: "skip" },                                    // salience → core+domain template
      { action: "accept", content: "# Diary\nstuff" },      // diary
      { action: "accept", content: "summary text" },        // summary
    ])
```

And append to that same test (before its closing `})`), asserting a skipped salience falls to the rendered spine:

```ts
    // skipped salience falls to the core+domain spine (SALIENCE.md is written)
    const salience = readFileSync(path.join(meDir("mix"), "SALIENCE.md"), "utf-8")
    expect(salience).toContain("# Salience")
    expect(salience).toContain("- safety: 0.5")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest --run packages/core/src/core/character-scaffold.test.ts`
Expected: FAIL — `SALIENCE.md` does not exist (`readFileSync` throws ENOENT); the scripted-review test's diary/summary assertions also drift until the step is wired.

- [ ] **Step 3: Import the salience helpers**

In `packages/core/src/core/character-scaffold.ts`, replace:

```ts
import { TEMPLATE_PALETTE, paletteFile } from "./palette.js"
import { renderDriveLines, drivesFile } from "#brain/limbic/hypothalamus/drives.js"
```

with:

```ts
import { TEMPLATE_PALETTE, paletteFile } from "./palette.js"
import { renderSalienceLines, salienceFile } from "./salience.js"
import { renderDriveLines, drivesFile } from "#brain/limbic/hypothalamus/drives.js"
```

- [ ] **Step 4: Update the `scaffoldCharacter` doc comment**

Replace the doc line:

```ts
 * With a `characterDescription`, generates background → values → palette →
 * diary → summary against the local conscious cortex tier, routing each
```

with:

```ts
 * With a `characterDescription`, generates background → values → palette →
 * drives → salience → diary → summary against the local conscious cortex tier,
 * routing each
```

- [ ] **Step 5: Add the default `salienceBody`**

Replace:

```ts
    const domainDrives = opts.domainConfig.identityTemplate?.domainDrives
    let driveBody = renderDriveLines(domainDrives)
    let diaryContent = DIARY_TEMPLATE
```

with:

```ts
    const domainDrives = opts.domainConfig.identityTemplate?.domainDrives
    let driveBody = renderDriveLines(domainDrives)
    let salienceBody = renderSalienceLines(domainDrives)
    let diaryContent = DIARY_TEMPLATE
```

- [ ] **Step 6: Run the `salience` step after `drives`**

Replace:

```ts
      const drv = yield* runStep("drives", ctx, opts.cortexModels, review)
      if (drv.kind === "content") driveBody = drv.value.trim()

      const diary = yield* runStep("diary", ctx, opts.cortexModels, review)
```

with:

```ts
      const drv = yield* runStep("drives", ctx, opts.cortexModels, review)
      if (drv.kind === "content") driveBody = drv.value.trim()
      // Salience depends on the approved drives (the spine) + values + background;
      // thread the approved drive block forward so the profile weights match it.
      ctx.baseDrives = driveBody

      const sal = yield* runStep("salience", ctx, opts.cortexModels, review)
      if (sal.kind === "content") salienceBody = sal.value.trim()

      const diary = yield* runStep("diary", ctx, opts.cortexModels, review)
```

- [ ] **Step 7: Write `SALIENCE.md` in the files array**

Replace:

```ts
      { name: "DRIVES.md", content: drivesFile(driveBody) },
      { name: "DIARY.md", content: diaryContent },
```

with:

```ts
      { name: "DRIVES.md", content: drivesFile(driveBody) },
      { name: "SALIENCE.md", content: salienceFile(salienceBody) },
      { name: "DIARY.md", content: diaryContent },
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm vitest --run packages/core/src/core/character-scaffold.test.ts`
Expected: PASS (all cases, including the three updated ones).

- [ ] **Step 9: Typecheck**

Run: `pnpm nx run @roci/core:typecheck --skip-nx-cache`
Expected: SUCCESS. `runStep("salience", …)` is valid because `"salience"` is now an `IdentityStep` member (Task 2), and `promptForStep` handles it.

- [ ] **Step 10: Commit**

```bash
cd /Users/vcarl/workspace/roci/.claude/worktrees/memory-provenance
git add packages/core/src/core/character-scaffold.ts packages/core/src/core/character-scaffold.test.ts
git commit -m "feat(identity): scaffold the salience profile after drives (SALIENCE.md)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Integration verification

- [ ] **Step 1: Run all Phase 2-touched test files**

Run: `pnpm vitest --run packages/core/src/core/salience.test.ts packages/core/src/core/identity-gen/prompts.test.ts packages/core/src/services/CharacterFs.test.ts packages/core/src/core/character-scaffold.test.ts`
Expected: PASS — all four files.

- [ ] **Step 2: Full `@roci/core` typecheck without cache**

Run: `pnpm nx run @roci/core:typecheck --skip-nx-cache`
Expected: SUCCESS.

- [ ] **Step 3: Confirm no memory-module coupling was introduced**

Run:
```bash
cd /Users/vcarl/workspace/roci/.claude/worktrees/memory-provenance
grep -rn "hippocampus/memory" packages/core/src/core/salience.ts packages/core/src/core/identity-gen/prompts.ts packages/core/src/services/CharacterFs.ts packages/core/src/core/character-scaffold.ts
```
Expected: NO matches — Phase 2 introduced no dependency on the memory-ranking module (spec §7 acceptance).

- [ ] **Step 4: Confirm the salience step is wired in order**

Run:
```bash
cd /Users/vcarl/workspace/roci/.claude/worktrees/memory-provenance
grep -n "runStep(\"drives\"\|runStep(\"salience\"\|runStep(\"diary\"\|SALIENCE.md" packages/core/src/core/character-scaffold.ts
```
Expected: `runStep("salience", …)` appears between `runStep("drives", …)` and `runStep("diary", …)`, and `SALIENCE.md` appears in the files array.

- [ ] **Step 5: Whole-repo build (the pre-commit gate, run explicitly)**

Run: `pnpm nx run-many -t build --skip-nx-cache`
Expected: SUCCESS across all projects.

- [ ] **Step 6: Final commit (only if a fixup was required)**

```bash
cd /Users/vcarl/workspace/roci/.claude/worktrees/memory-provenance
git add -A packages/core/src
git commit -m "chore(identity): integration fixups for salience profile

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

If no fixup was needed, skip this step.

---

## Self-Review

**1. Spec coverage (§2 / §7 Phase 2 / §8 P2 tests):**
- New `salience` `IdentityStep` run after `drives` via `runStep` → Task 2 (step + prompt) + Task 4 (wiring after drives).
- `buildSaliencePrompt` sibling to `buildPalettePrompt`, injecting drives + values + background → Task 2 (`buildSaliencePrompt` reads `ctx.baseDrives`/`values`/`background`; Task 4 threads the approved drives into `ctx.baseDrives`).
- `SALIENCE.md` at `players/<name>/me/SALIENCE.md`, exact line format, dimensions = core + domain spine + ≤2 extras → Task 1 (`salienceFile`, `renderSalienceLines`, format enforced in prompt Task 2) + Task 4 (write).
- `salienceFile(body)` wrapper mirroring `paletteFile`/`drivesFile` → Task 1.
- `parseSalience(md): Record<string, number>`, pure, clamp to [0,1], drop malformed, mirrors `parseDriveNames` → Task 1.
- `CharacterFs.readSalience(char)` with `TEMPLATE_SALIENCE` fallback (core + domain neutral 0.5) → Task 3 (fallback) + Task 1 (`TEMPLATE_SALIENCE` core spine; domain rows via `renderSalienceLines` at scaffold time).
- §8 P2 test names: `parseSalience` well-formed→map / clamp / drop-malformed / core+domain present / ≤2 extras (Task 1); `TEMPLATE_SALIENCE` parses (Task 1); `buildSaliencePrompt` includes drives+values context (Task 2); `scaffoldCharacter` writes `SALIENCE.md` via a fake generator (Task 4). All present.
- §7 acceptance: scaffolded character gets a reviewed `SALIENCE.md` (Task 4); `parseSalience` round-trips (Task 1); no memory-ranking dependency (Task 5 Step 3 grep gate). Covered.

**2. Placeholder scan:** No "TBD"/"similar to Task N"/"add error handling" placeholders. Every code step shows exact code; every run step shows exact command + expected PASS/FAIL.

**3. Type consistency:** `TEMPLATE_SALIENCE`, `renderSalienceLines(domainDrives?)`, `salienceFile(body)`, `parseSalience(md)` defined in Task 1 are consumed with identical names/signatures in Tasks 3 (`TEMPLATE_SALIENCE`) and 4 (`renderSalienceLines`, `salienceFile`). `buildSaliencePrompt(ctx)` and the `"salience"` `IdentityStep` from Task 2 are consumed by `runStep("salience", …)` and `promptForStep` in Task 4. `readSalience` returns `Effect.Effect<string, CharacterFsError>` consistently (interface + impl, Task 3). `DomainDrive` is imported type-only in Task 1 with the shape it has in `drives.ts`. No drift found.

---

## Resolved ambiguity (worth the reviewer's attention)

**`TEMPLATE_SALIENCE` core-only vs "includes the domain drive."** The spec (§2 and the Global-Constraints wording) describes the `readSalience` fallback as "all core + domain drives at neutral 0.5." But `CharacterFs.readSalience` — like the `readDrives`/`readPalette` it mirrors — has no access to the `DomainConfig`, so it cannot know the domain drive name. The established pattern is exactly this: `readDrives` falls back to `TEMPLATE_DRIVES`, which is **core-only** (the domain drive is merged in only at scaffold time by `renderDriveLines(domainDrives)`). This plan mirrors that faithfully: `TEMPLATE_SALIENCE` is the **core spine at 0.5** (the domain-agnostic fallback), and `renderSalienceLines(domainDrives)` is what puts the domain drive into every *scaffolded* `SALIENCE.md`. So a character scaffolded under Phase 2 gets `safety`/`sustenance`/`agency` + the domain drive; a legacy character with no `SALIENCE.md` degrades to the core spine at neutral (and in Phase 3, the un-profiled domain dimension simply takes the neutral-salience path). This satisfies the operative requirement — "still ranks sanely" — without inventing a domain-config channel into `CharacterFs` that the sibling readers don't have. If the reviewer wants the fallback to literally carry the domain drive, that requires widening `CharacterConfig`/`readSalience` to receive the domain drives, which would also warrant doing the same for `readDrives` — out of Phase 2 scope; flag for a follow-up.

## Hand-off to Phase 3

Phase 3 (salience-decay ranking) consumes this profile: the memory gateway will call `CharacterFs.readSalience(char)` then `parseSalience(...)` to get `Record<string, number>`, and feed it into `salienceWeight`/`halfLife`/`recency` in `memory-rank.ts`. Nothing in Phase 2 touches the memory module; `parseSalience`'s `Record<string, number>` output is the contract Phase 3 builds on.
