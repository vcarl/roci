# Local, Interactive Character Creation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Claude-in-a-container one-shot character scaffold with an orchestrator-driven, step-by-step wizard that generates each identity artifact with the local conscious-tier mlx model, lets the operator review/edit/regenerate each step, emits a 5-emoji-gradient palette, and seeds a model-designed diary structure — failing hard (no silent template fallback) when the model can't produce.

**Architecture:** A new pure `identity-gen` module holds per-artifact prompt builders + a thin generator that calls `ModelClient.complete(handle, …)` under `ModelService.withTier("conscious")` (the `callTier` pattern). `character-scaffold.ts` becomes orchestration + file-writing: it drives the step sequence through an injected `review` callback (so the interactive `@effect/cli` Prompt UI stays in the app layer) and writes files. `guided-setup.ts` supplies the interactive review function; `cli.ts` provides the `ModelService` layer to the setup command so the resident conscious server cold-loads during setup.

**Tech Stack:** TypeScript, Effect (effect / @effect/cli / @effect/platform), vitest, nx/pnpm monorepo, local mlx (`mlx_lm.server`, OpenAI-compatible).

## Global Constraints

- **Local-only, no Claude, no container.** Generation uses the conscious cortex tier over HTTP via `ModelClient` + `ModelService.withTier("conscious")`. No `Docker`, `OAuthToken`, `runTurn`, or `roci-scaffold-*` container on this path.
- **Conscious-tier model.** Use the same handle the running loop uses: `resolveHandle(cortexModels, "conscious")` where `cortexModels` defaults to `DEFAULT_CORTEX_MODELS` (`packages/core/src/model/handles.ts:48`). Do not hardcode a model id.
- **Fail hard, no silent fallback.** If the tier can't be acquired (`SpawnError`/`ReadinessError`) or a step returns empty content (`EmptyGenerationError`), the wizard stops with a clear typed error. The only path to a plain template for an artifact is an explicit operator **skip**.
- **Never overwrite existing files.** The file-writing loop skips any file that already exists (preserve current behavior).
- **Palette = 5-emoji axis gradient.** Each row: 5 emoji from one pole through the middle to the other, then `# poleA → poleB`. ~4–6 rows. Reader paints by position + repeat-for-intensity.
- **Non-interactive / CI path is OUT OF SCOPE** (and the `setup --domain` registration-code hang). Keep the non-interactive `setup --domain` branch compiling by passing `autoAcceptReview`; do not invest in it further.

---

### Task 1: Palette 5-emoji gradient format

**Files:**
- Modify: `packages/core/src/core/palette.ts`
- Modify: `packages/core/src/skills/observe.md:31-36`
- Modify: `packages/core/src/skills/types.ts:13-14`
- Test: `packages/core/src/core/palette.test.ts` (create)

No change to `skills/orient.md` — it only carries `emotionalWeight` forward (`:35,61`), it does not describe the palette format.

**Interfaces:**
- Consumes: nothing.
- Produces: updated `TEMPLATE_PALETTE` (string, 5-emoji gradient rows) and `paletteFile(body: string): string` (unchanged signature).

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/core/palette.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { TEMPLATE_PALETTE, paletteFile } from "./palette.js"

describe("TEMPLATE_PALETTE (5-emoji gradient)", () => {
  const rows = TEMPLATE_PALETTE.trim().split("\n")

  it("has 4-6 rows", () => {
    expect(rows.length).toBeGreaterThanOrEqual(4)
    expect(rows.length).toBeLessThanOrEqual(6)
  })

  it("each row is 5 emoji then a '# poleA → poleB' gloss", () => {
    for (const row of rows) {
      const [emojiPart, gloss] = row.split("#")
      expect(gloss, `row missing gloss: ${row}`).toBeDefined()
      expect(gloss).toContain("→")
      // 5 whitespace-separated emoji tokens before the '#'
      const tokens = emojiPart.trim().split(/\s+/)
      expect(tokens.length, `row not 5 emoji: ${row}`).toBe(5)
    }
  })

  it("no longer uses the old two-pole ↔ separator", () => {
    expect(TEMPLATE_PALETTE).not.toContain("↔")
  })
})

describe("paletteFile", () => {
  it("wraps a body under the # Palette header and mentions intensity-by-repetition", () => {
    const out = paletteFile("🌊 💧 😶 🌤️ ☁️   # sinking → soaring")
    expect(out.startsWith("# Palette")).toBe(true)
    expect(out).toContain("🌊 💧 😶 🌤️ ☁️")
    expect(out.toLowerCase()).toContain("repeat")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/core/palette.test.ts`
Expected: FAIL (current `TEMPLATE_PALETTE` uses `↔`; header guide lacks "repeat").

- [ ] **Step 3: Update `palette.ts`**

Replace the whole file body with:

```typescript
/**
 * The emotional palette — a character's nonverbal "voice." Each line is one
 * emotional axis expressed as a 5-emoji gradient from one pole through the
 * middle to the other; the hindbrain paints its gut reaction by picking a
 * position along the gradient (repeat an emoji for intensity) rather than with
 * words. Characters get a personalized palette generated at creation time
 * (identity-gen); this seed is the graceful-degradation default and the eval
 * reference.
 */
export const TEMPLATE_PALETTE = `🌊 💧 😶 🌤️ ☁️   # sinking → soaring
😱 😟 😐 🙂 😌   # panic → calm
🔥 😤 😐 🧘 🥶   # fury → numb
🏙️ 🚶 😐 🛖 🌲   # stir → stillness
👶 🤩 😐 😪 🧓   # wonder → weariness`

/** Wrap a palette body in the human-readable PALETTE.md file header. */
export const paletteFile = (body: string): string =>
  `# Palette
<!-- This character's emotional voice — the axes they feel along. Each row is a
     5-emoji gradient from one pole to the other. Paint feelings by picking the
     position along the gradient that fits; repeat an emoji to show intensity
     (😟😟😟 = deep toward that pole); mix axes when a feeling is tangled. -->

${body.trim()}
`
```

Every row must have exactly 5 single emoji tokens separated by spaces before the `#` (the Task 1 test enforces this).

- [ ] **Step 4: Update the consumer instruction in `observe.md:31-36`**

Replace the "How you feel" bullet and examples:

```markdown
2. **How you feel** — paint your gut reaction as emoji, no words. Use your palette below: each row is a 5-emoji gradient between two poles. Pick the emoji at the position you're sitting; repeat it to show intensity (`😟😟😟` = deep toward that pole); mix rows when the feeling is tangled. This is your gut, not your analysis.

   Your palette:
   {{palette}}

   Examples: `🌊🌊🌊` (deep toward sinking) · `🥶🔥` (gone numb, anger flaring) · `🙂🤩` (calm and lit-up). Coin new emoji when nothing in the palette fits the feeling.
```

- [ ] **Step 5: Update the doc comment in `skills/types.ts:13-14`**

```typescript
  /** Emoji mood line painted from the character's palette: each palette row is a
   *  5-emoji gradient between two poles — position = where you sit, repeats =
   *  intensity, mixed rows = a chord. */
  readonly emotionalWeight: string
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/core/palette.test.ts`
Expected: PASS (all three describe blocks).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/core/palette.ts packages/core/src/core/palette.test.ts packages/core/src/skills/observe.md packages/core/src/skills/types.ts
git commit -m "feat(palette): 5-emoji axis-gradient palette format

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: identity-gen prompt builders

**Files:**
- Create: `packages/core/src/core/identity-gen/prompts.ts`
- Test: `packages/core/src/core/identity-gen/prompts.test.ts`

**Interfaces:**
- Consumes: nothing (pure string builders).
- Produces:
  - `type IdentityStep = "background" | "values" | "palette" | "diary" | "summary"`
  - `interface IdentityContext { characterName: string; characterDescription: string; identityTemplate?: { backgroundHints: string; valuesHints: string }; background?: string; values?: string; feedback?: string }`
  - `buildBackgroundPrompt(ctx: IdentityContext): string`
  - `buildValuesPrompt(ctx: IdentityContext): string`
  - `buildPalettePrompt(ctx: IdentityContext): string`
  - `buildDiaryPrompt(ctx: IdentityContext): string`
  - `buildSummaryPrompt(ctx: IdentityContext): string`
  - `promptForStep(step: IdentityStep, ctx: IdentityContext): string` (dispatch helper)

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/core/identity-gen/prompts.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import {
  buildBackgroundPrompt,
  buildValuesPrompt,
  buildPalettePrompt,
  buildDiaryPrompt,
  buildSummaryPrompt,
  promptForStep,
  type IdentityContext,
} from "./prompts.js"

const base: IdentityContext = {
  characterName: "Dust",
  characterDescription: "a weathered solo asteroid prospector who distrusts factions",
  identityTemplate: { backgroundHints: "space MMO", valuesHints: "resource management" },
}

describe("prompt builders", () => {
  it("background prompt includes name, description and domain hints", () => {
    const p = buildBackgroundPrompt(base)
    expect(p).toContain("Dust")
    expect(p).toContain("weathered solo asteroid prospector")
    expect(p).toContain("space MMO")
  })

  it("values prompt threads the approved background", () => {
    const p = buildValuesPrompt({ ...base, background: "BACKGROUND-MARKER" })
    expect(p).toContain("BACKGROUND-MARKER")
    expect(p).toContain("resource management")
  })

  it("palette prompt asks for 5-emoji gradient rows and threads background+values", () => {
    const p = buildPalettePrompt({ ...base, background: "BG", values: "VAL" })
    expect(p).toContain("5 emoji")
    expect(p).toContain("→")
    expect(p).toContain("BG")
    expect(p).toContain("VAL")
  })

  it("diary prompt offers 8 example structures and threads values", () => {
    const p = buildDiaryPrompt({ ...base, background: "BG", values: "VAL" })
    expect(p).toContain("VAL")
    // 8 numbered example structures
    for (let n = 1; n <= 8; n++) expect(p).toContain(`${n}.`)
  })

  it("summary prompt asks for exactly 4 sentences from the background", () => {
    const p = buildSummaryPrompt({ ...base, background: "BG" })
    expect(p).toContain("4 sentences")
    expect(p).toContain("BG")
  })

  it("feedback note is appended when present", () => {
    const p = buildBackgroundPrompt({ ...base, feedback: "make her grimmer" })
    expect(p).toContain("make her grimmer")
  })

  it("promptForStep dispatches by step", () => {
    expect(promptForStep("background", base)).toBe(buildBackgroundPrompt(base))
    expect(promptForStep("diary", { ...base, values: "VAL" })).toContain("VAL")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/core/identity-gen/prompts.test.ts`
Expected: FAIL ("Cannot find module './prompts.js'").

- [ ] **Step 3: Write `prompts.ts`**

```typescript
export type IdentityStep = "background" | "values" | "palette" | "diary" | "summary"

export interface IdentityContext {
  characterName: string
  characterDescription: string
  identityTemplate?: { backgroundHints: string; valuesHints: string }
  /** Approved prior artifacts, threaded forward as later steps are generated. */
  background?: string
  values?: string
  /** Operator feedback to steer a regeneration of the current step. */
  feedback?: string
}

const feedbackBlock = (ctx: IdentityContext): string =>
  ctx.feedback ? `\n\nThe previous attempt needs revision. Operator feedback: ${ctx.feedback}\n` : ""

export const buildBackgroundPrompt = (ctx: IdentityContext): string => {
  const hint = ctx.identityTemplate ? `\nDomain context: ${ctx.identityTemplate.backgroundHints}\n` : ""
  return `You are generating the BACKGROUND document for an AI character named "${ctx.characterName}".

The user described this character as: ${ctx.characterDescription}
${hint}${feedbackBlock(ctx)}
Write a rich identity narrative — who they are, how they think, what motivates them, how they operate. Detailed enough to guide an AI agent's behavior and personality across many interactions. Write in a voice that fits the character. Aim for 300-800 words.

Output ONLY the background prose. No preamble, no headings, no commentary.`
}

export const buildValuesPrompt = (ctx: IdentityContext): string => {
  const hint = ctx.identityTemplate ? `\nDomain context: ${ctx.identityTemplate.valuesHints}\n` : ""
  return `You are generating the VALUES document for an AI character named "${ctx.characterName}".

Here is the character's approved background:
${ctx.background ?? "(none)"}
${hint}${feedbackBlock(ctx)}
Write the character's working values and principles — concrete, actionable guidelines that shape decisions, not generic platitudes. Each value gets a short bold heading and 1-3 sentences. Aim for 5-10 values, grounded in the background above.

Output ONLY the values. No preamble, no commentary.`
}

export const buildPalettePrompt = (ctx: IdentityContext): string => {
  return `You are generating the emotional PALETTE for an AI character named "${ctx.characterName}".

Approved background:
${ctx.background ?? "(none)"}

Approved values:
${ctx.values ?? "(none)"}
${feedbackBlock(ctx)}
Give this character 4-6 emotional axes — the axes they feel along (their nonverbal "voice"). Express EACH axis as a gradient of exactly 5 emoji stepping from one emotional pole, through a neutral middle, to the opposite pole. After the 5 emoji put " # " then a short "poleA → poleB" gloss. One axis per line. Choose poles that fit THIS character's soul and world. Example:
🌊 💧 😶 🌤️ ☁️   # sinking → soaring

Output ONLY the axis lines, no commentary.`
}

export const buildDiaryPrompt = (ctx: IdentityContext): string => {
  return `You are designing the DIARY structure for an AI character named "${ctx.characterName}".

Approved background:
${ctx.background ?? "(none)"}

Approved values:
${ctx.values ?? "(none)"}
${feedbackBlock(ctx)}
Design a diary structure that fits THIS character's values and voice — the standing sections and/or log format they would naturally keep. Seed it with character-appropriate placeholder structure (headings, brief guide notes, and one seed entry where it fits), ready for the character to maintain during play. Here are 8 example structures for inspiration — choose, adapt, or blend; do not feel bound to them:

1. Standing sections (Relationships / Open Threads / Grudges & Debts) plus a dated Running Log.
2. A ship's or captain's log — chronological, terse, operational.
3. A field naturalist's catalog — cataloged finds and observations with annotations.
4. A ledger of debts and favors owed and owing.
5. A confessional — private reflections addressed to someone.
6. A maintenance log — systems, faults, fixes, recurring worries.
7. A coded manifest or smuggler's shorthand.
8. A star-chart or route-annotation system.

Output ONLY the diary markdown, starting with "# Diary". No preamble, no commentary.`
}

export const buildSummaryPrompt = (ctx: IdentityContext): string =>
  `Here is the background document for an AI character named "${ctx.characterName}":

${ctx.background ?? "(none)"}

Write exactly 4 sentences summarizing this character's identity, personality, and motivations. Be concise and vivid. Output ONLY the summary, no preamble.`

export const promptForStep = (step: IdentityStep, ctx: IdentityContext): string => {
  switch (step) {
    case "background":
      return buildBackgroundPrompt(ctx)
    case "values":
      return buildValuesPrompt(ctx)
    case "palette":
      return buildPalettePrompt(ctx)
    case "diary":
      return buildDiaryPrompt(ctx)
    case "summary":
      return buildSummaryPrompt(ctx)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/core/identity-gen/prompts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/core/identity-gen/prompts.ts packages/core/src/core/identity-gen/prompts.test.ts
git commit -m "feat(identity-gen): per-artifact prompt builders

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: identity-gen generator (conscious-tier call)

**Files:**
- Create: `packages/core/src/core/identity-gen/generate.ts`
- Test: `packages/core/src/core/identity-gen/generate.test.ts`

**Interfaces:**
- Consumes: `ModelClient` (`packages/core/src/model/client.ts:63`), `ModelService` (`packages/core/src/services/ModelService.ts:9`), `resolveHandle`/`DEFAULT_CORTEX_MODELS`/`CortexModelConfig` (`packages/core/src/model/handles.ts`), `ModelError` (`model/errors.ts`), `SpawnError`/`ReadinessError` (`services/model-backend.ts`).
- Produces:
  - `class EmptyGenerationError { readonly _tag = "EmptyGenerationError"; constructor(readonly step: string); get message(): string }`
  - `generateArtifact(step: string, prompt: string, cortexModels?: CortexModelConfig): Effect.Effect<string, ModelError | SpawnError | ReadinessError | EmptyGenerationError, ModelClient | ModelService>`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/core/identity-gen/generate.test.ts` (mock-layer pattern from `cortex/tiers.test.ts:37-60`):

```typescript
import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { ModelClient } from "../../model/client.js"
import { ModelService } from "../../services/ModelService.js"
import type { ModelHandle } from "../../model/handles.js"
import { generateArtifact, EmptyGenerationError } from "./generate.js"

const fixedClient = (text: string): Layer.Layer<ModelClient> =>
  Layer.succeed(ModelClient, ModelClient.of({ complete: (_h: ModelHandle) => Effect.succeed({ text, raw: {} }) }))

const recordingService = (sink: string[]): Layer.Layer<ModelService> =>
  Layer.succeed(
    ModelService,
    ModelService.of({
      withTier: (tier) => (effect) => {
        sink.push(tier)
        return effect as never
      },
    }),
  )

describe("generateArtifact", () => {
  it("returns trimmed text and routes through the conscious tier", async () => {
    const tiers: string[] = []
    const out = await Effect.runPromise(
      Effect.provide(
        generateArtifact("background", "prompt"),
        Layer.mergeAll(fixedClient("  hello world  "), recordingService(tiers)),
      ),
    )
    expect(out).toBe("hello world")
    expect(tiers).toEqual(["conscious"])
  })

  it("fails with EmptyGenerationError on empty content", async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        generateArtifact("values", "prompt"),
        Layer.mergeAll(fixedClient("   "), recordingService([])),
      ).pipe(Effect.either),
    )
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") expect(result.left).toBeInstanceOf(EmptyGenerationError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/core/identity-gen/generate.test.ts`
Expected: FAIL ("Cannot find module './generate.js'").

- [ ] **Step 3: Write `generate.ts`**

```typescript
import { Effect } from "effect"
import { ModelClient, type ChatMessage } from "../../model/client.js"
import { ModelService } from "../../services/ModelService.js"
import {
  resolveHandle,
  DEFAULT_CORTEX_MODELS,
  type CortexModelConfig,
} from "../../model/handles.js"
import type { ModelError } from "../../model/errors.js"
import type { SpawnError, ReadinessError } from "../../services/model-backend.js"

/** A generation step returned empty content from the model — fail hard, do not
 *  silently fall back to a template. */
export class EmptyGenerationError {
  readonly _tag = "EmptyGenerationError"
  constructor(readonly step: string) {}
  get message(): string {
    return `Identity generation returned empty content for step: ${this.step}`
  }
  toString(): string {
    return this.message
  }
}

/**
 * Generate one identity artifact by calling the conscious cortex tier directly
 * over HTTP (the `callTier` pattern), gated by ModelService.withTier so the
 * resident server is ready. Uses the same conscious handle as the running loop.
 */
export const generateArtifact = (
  step: string,
  prompt: string,
  cortexModels: CortexModelConfig = DEFAULT_CORTEX_MODELS,
): Effect.Effect<
  string,
  ModelError | SpawnError | ReadinessError | EmptyGenerationError,
  ModelClient | ModelService
> =>
  Effect.gen(function* () {
    const svc = yield* ModelService
    const client = yield* ModelClient
    const handle = resolveHandle(cortexModels, "conscious")
    const messages: ChatMessage[] = [{ role: "user", content: prompt }]
    const res = yield* svc.withTier("conscious")(client.complete(handle, messages))
    const text = res.text.trim()
    if (!text) return yield* Effect.fail(new EmptyGenerationError(step))
    return text
  })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/core/identity-gen/generate.test.ts`
Expected: PASS (both cases; first asserts the tier routed was `conscious`).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/core/identity-gen/generate.ts packages/core/src/core/identity-gen/generate.test.ts
git commit -m "feat(identity-gen): conscious-tier generator with hard-fail on empty

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Rewrite `character-scaffold.ts` (review-driven orchestration)

**Files:**
- Modify (full rewrite of generation path): `packages/core/src/core/character-scaffold.ts`
- Test: `packages/core/src/core/character-scaffold.test.ts` (create)
- Modify (export new types): `packages/core/src/index.ts` (the `scaffoldCharacter` re-export at `:4` already exists; add the new `ReviewFn`/`ReviewDecision`/`autoAcceptReview` exports)

**Interfaces:**
- Consumes: `generateArtifact` + `promptForStep`/`IdentityContext`/`IdentityStep` (Tasks 2-3), `TEMPLATE_PALETTE`/`paletteFile` (Task 1), `DomainConfig` (`core/domain-bundle.js`), `CortexModelConfig` (`model/handles.js`), `ModelClient`/`ModelService`.
- Produces:
  - `type ReviewDecision = { action: "accept"; content: string } | { action: "regenerate"; feedback?: string } | { action: "skip" }`
  - `type ReviewFn = (step: IdentityStep, content: string) => Effect.Effect<ReviewDecision>`
  - `const autoAcceptReview: ReviewFn`
  - `scaffoldCharacter(opts: { projectRoot: string; characterName: string; identityTemplate?: { backgroundHints: string; valuesHints: string }; characterDescription?: string; cortexModels?: CortexModelConfig; domainConfig: DomainConfig; review?: ReviewFn }): Effect.Effect<{ results: string[]; summary?: string }, ModelError | SpawnError | ReadinessError | EmptyGenerationError, ModelClient | ModelService>`

NOTE: the requirements channel changes from `Docker | CommandExecutor | CharacterLog | OAuthToken` to `ModelClient | ModelService`. Callers (Task 5) must be updated.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/core/character-scaffold.test.ts`. Uses a tmp dir, a fixed `ModelClient`, a recording `ModelService`, and a **scripted review** that returns queued decisions:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect, Layer } from "effect"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { ModelClient } from "../model/client.js"
import { ModelService } from "../services/ModelService.js"
import type { ModelHandle } from "../model/handles.js"
import { scaffoldCharacter, autoAcceptReview, type ReviewDecision, type ReviewFn } from "./character-scaffold.js"
import type { DomainConfig } from "./domain-bundle.js"

// minimal DomainConfig stub — only identityTemplate matters here
const domainConfig = { identityTemplate: { backgroundHints: "h", valuesHints: "v" } } as unknown as DomainConfig

// model returns the prompt's first line tag so we can tell artifacts apart
const taggedClient: Layer.Layer<ModelClient> = Layer.succeed(
  ModelClient,
  ModelClient.of({
    complete: (_h: ModelHandle, messages) =>
      Effect.succeed({ text: `GEN:${messages[0].content.slice(0, 24)}`, raw: {} }),
  }),
)
const passThroughService: Layer.Layer<ModelService> = Layer.succeed(
  ModelService,
  ModelService.of({ withTier: () => (e) => e as never }),
)
const layers = Layer.mergeAll(taggedClient, passThroughService)

// scripted review: pull decisions from a queue keyed by call order
const scriptedReview = (decisions: ReviewDecision[]): ReviewFn => {
  let i = 0
  return () => Effect.succeed(decisions[i++] ?? { action: "accept", content: "FALLBACK" })
}

let root: string
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "scaffold-")) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const meDir = (name: string) => path.join(root, "players", name, "me")

describe("scaffoldCharacter", () => {
  it("with no description writes plain templates and makes no model call", async () => {
    const out = await Effect.runPromise(
      Effect.provide(
        scaffoldCharacter({ projectRoot: root, characterName: "tmpl", domainConfig, review: autoAcceptReview }),
        layers,
      ),
    )
    expect(existsSync(path.join(meDir("tmpl"), "background.md"))).toBe(true)
    expect(readFileSync(path.join(meDir("tmpl"), "DIARY.md"), "utf-8")).toContain("# Diary")
    expect(out.summary).toBeUndefined()
  })

  it("with a description generates each artifact and accepts them", async () => {
    const out = await Effect.runPromise(
      Effect.provide(
        scaffoldCharacter({
          projectRoot: root, characterName: "gen", characterDescription: "a prospector",
          domainConfig, review: autoAcceptReview,
        }),
        layers,
      ),
    )
    const bg = readFileSync(path.join(meDir("gen"), "background.md"), "utf-8")
    expect(bg).toContain("GEN:")
    expect(out.summary).toContain("GEN:")
  })

  it("regenerate threads feedback then accept; skip writes template", async () => {
    // step order: background, values, palette, diary, summary
    const review = scriptedReview([
      { action: "regenerate", feedback: "grimmer" },        // background: re-roll once
      { action: "accept", content: "BG-OK" },               // background: accept edited
      { action: "accept", content: "VAL-OK" },              // values
      { action: "skip" },                                    // palette → TEMPLATE_PALETTE
      { action: "accept", content: "# Diary\nstuff" },      // diary
      { action: "accept", content: "summary text" },        // summary
    ])
    await Effect.runPromise(
      Effect.provide(
        scaffoldCharacter({
          projectRoot: root, characterName: "mix", characterDescription: "x",
          domainConfig, review,
        }),
        layers,
      ),
    )
    expect(readFileSync(path.join(meDir("mix"), "background.md"), "utf-8")).toContain("BG-OK")
    // skipped palette falls to the template default
    expect(readFileSync(path.join(meDir("mix"), "PALETTE.md"), "utf-8")).toContain("→")
  })

  it("never overwrites an existing file", async () => {
    // first run
    await Effect.runPromise(Effect.provide(
      scaffoldCharacter({ projectRoot: root, characterName: "keep", domainConfig, review: autoAcceptReview }), layers))
    const before = readFileSync(path.join(meDir("keep"), "background.md"), "utf-8")
    // second run with a description must not overwrite
    await Effect.runPromise(Effect.provide(
      scaffoldCharacter({ projectRoot: root, characterName: "keep", characterDescription: "y", domainConfig, review: autoAcceptReview }), layers))
    expect(readFileSync(path.join(meDir("keep"), "background.md"), "utf-8")).toBe(before)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/core/character-scaffold.test.ts`
Expected: FAIL (old `scaffoldCharacter` signature requires Docker/OAuth and has no `review`; `autoAcceptReview`/`ReviewDecision` not exported).

- [ ] **Step 3: Rewrite `character-scaffold.ts`**

Replace the entire file with:

```typescript
import { Effect } from "effect"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import type { DomainConfig } from "./domain-bundle.js"
import type { CortexModelConfig } from "../model/handles.js"
import type { ModelClient } from "../model/client.js"
import type { ModelService } from "../services/ModelService.js"
import type { ModelError } from "../model/errors.js"
import type { SpawnError, ReadinessError } from "../services/model-backend.js"
import { TEMPLATE_PALETTE, paletteFile } from "./palette.js"
import {
  promptForStep,
  type IdentityContext,
  type IdentityStep,
} from "./identity-gen/prompts.js"
import { generateArtifact, EmptyGenerationError } from "./identity-gen/generate.js"

const BACKGROUND_TEMPLATE = `# Background

<!-- Write your character's background here. This is their identity narrative —
     who they are, how they think, what drives them. The AI reads this on every
     planning cycle to stay in character. -->
`
const VALUES_TEMPLATE = `# Values

<!-- Write your character's working values here. These define how the character
     operates — their priorities, principles, and decision-making framework. -->
`
const DIARY_TEMPLATE = `# Diary
`
const SECRETS_TEMPLATE = `# Secrets
`

/** Operator's decision on a generated artifact during the interactive review. */
export type ReviewDecision =
  | { action: "accept"; content: string }
  | { action: "regenerate"; feedback?: string }
  | { action: "skip" }

/** Injected by the caller (the app's setup UI) to review each generated step.
 *  Keeping it a callback keeps interactive @effect/cli Prompt out of core. */
export type ReviewFn = (step: IdentityStep, content: string) => Effect.Effect<ReviewDecision>

/** Non-interactive default — accept every generated artifact unchanged. */
export const autoAcceptReview: ReviewFn = (_step, content) =>
  Effect.succeed({ action: "accept", content })

type StepOutcome = { kind: "content"; value: string } | { kind: "skip" }

/** Generate one step, looping on `regenerate` (threading feedback) until the
 *  operator accepts (with possibly-edited content) or skips. */
const runStep = (
  step: IdentityStep,
  ctx: IdentityContext,
  cortexModels: CortexModelConfig | undefined,
  review: ReviewFn,
): Effect.Effect<
  StepOutcome,
  ModelError | SpawnError | ReadinessError | EmptyGenerationError,
  ModelClient | ModelService
> =>
  Effect.gen(function* () {
    let feedback: string | undefined
    // bounded loop guard against a pathological regenerate cycle
    for (let attempt = 0; attempt < 20; attempt++) {
      const prompt = promptForStep(step, { ...ctx, feedback })
      const content = yield* generateArtifact(step, prompt, cortexModels)
      const decision = yield* review(step, content)
      if (decision.action === "accept") return { kind: "content", value: decision.content }
      if (decision.action === "skip") return { kind: "skip" }
      feedback = decision.feedback
    }
    return { kind: "skip" }
  })

/**
 * Scaffold a new character's identity files under `players/<name>/me/`.
 *
 * With a `characterDescription`, generates background → values → palette →
 * diary → summary against the local conscious cortex tier, routing each
 * artifact through the injected `review` callback (accept / edit / regenerate /
 * skip). Without a description, writes plain seed templates and makes no model
 * call. Fails hard on a model/readiness/empty-content error — it never writes a
 * boilerplate file and reports success. Existing files are never overwritten.
 */
export const scaffoldCharacter = (opts: {
  projectRoot: string
  characterName: string
  identityTemplate?: { backgroundHints: string; valuesHints: string }
  characterDescription?: string
  cortexModels?: CortexModelConfig
  domainConfig: DomainConfig
  review?: ReviewFn
}): Effect.Effect<
  { results: string[]; summary?: string },
  ModelError | SpawnError | ReadinessError | EmptyGenerationError,
  ModelClient | ModelService
> =>
  Effect.gen(function* () {
    const { projectRoot, characterName, identityTemplate, characterDescription } = opts
    const review = opts.review ?? autoAcceptReview
    const charDir = path.resolve(projectRoot, "players", characterName, "me")
    const results: string[] = []

    if (!existsSync(charDir)) {
      mkdirSync(charDir, { recursive: true })
      results.push(`created directory: ${charDir}`)
    }

    // Defaults = plain templates (used with no description, or on an explicit skip).
    let backgroundContent = identityTemplate
      ? BACKGROUND_TEMPLATE + `\n## Domain Context\n\n${identityTemplate.backgroundHints}\n`
      : BACKGROUND_TEMPLATE
    let valuesContent = identityTemplate
      ? VALUES_TEMPLATE + `\n## Domain Context\n\n${identityTemplate.valuesHints}\n`
      : VALUES_TEMPLATE
    let paletteBody = TEMPLATE_PALETTE
    let diaryContent = DIARY_TEMPLATE
    let summary: string | undefined

    if (characterDescription) {
      const ctx: IdentityContext = { characterName, characterDescription, identityTemplate }

      const bg = yield* runStep("background", ctx, opts.cortexModels, review)
      if (bg.kind === "content") {
        backgroundContent = bg.value.trim() + "\n"
        ctx.background = bg.value.trim()
      }

      const val = yield* runStep("values", ctx, opts.cortexModels, review)
      if (val.kind === "content") {
        valuesContent = val.value.trim() + "\n"
        ctx.values = val.value.trim()
      }

      const pal = yield* runStep("palette", ctx, opts.cortexModels, review)
      if (pal.kind === "content") paletteBody = pal.value.trim()

      const diary = yield* runStep("diary", ctx, opts.cortexModels, review)
      if (diary.kind === "content") diaryContent = diary.value.trim() + "\n"

      const sum = yield* runStep("summary", ctx, opts.cortexModels, review)
      if (sum.kind === "content") summary = sum.value.trim()

      results.push(`generated identity for ${characterName}`)
    }

    const files: Array<{ name: string; content: string }> = [
      { name: "background.md", content: backgroundContent },
      { name: "VALUES.md", content: valuesContent },
      { name: "PALETTE.md", content: paletteFile(paletteBody) },
      { name: "DIARY.md", content: diaryContent },
      { name: "SECRETS.md", content: SECRETS_TEMPLATE },
    ]

    for (const file of files) {
      const filePath = path.resolve(charDir, file.name)
      if (existsSync(filePath)) {
        results.push(`skipped: ${filePath} (already exists)`)
      } else {
        writeFileSync(filePath, file.content)
        results.push(`created: ${filePath}`)
      }
    }

    return { results, summary }
  })
```

- [ ] **Step 4: Export the new types from `index.ts`**

In `packages/core/src/index.ts`, change the existing scaffold export line (`:4`) to also export the new types:

```typescript
export { scaffoldCharacter, autoAcceptReview } from "./core/character-scaffold.js";
export type { ReviewFn, ReviewDecision } from "./core/character-scaffold.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/core/character-scaffold.test.ts`
Expected: PASS (all four cases).

- [ ] **Step 6: Build the core package to confirm types**

Run: `pnpm nx run @roci/core:build`
Expected: `tsc` passes (the requirements-channel change compiles).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/core/character-scaffold.ts packages/core/src/core/character-scaffold.test.ts packages/core/src/index.ts
git commit -m "feat(scaffold): review-driven local generation, drop container/Claude path

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Wire interactive review into guided-setup + cli layers

**Files:**
- Modify: `apps/roci/src/setup/guided-setup.ts` (add `interactiveReview`, pass it to `scaffoldCharacter`, drop the `models` arg)
- Modify: `apps/roci/src/cli.ts` (provide `modelServiceLayer` to `setupCommand`; update the `setup --domain` branch call to drop `models` and pass `autoAcceptReview`)
- Test: `apps/roci/src/setup/review.test.ts` (create — tests a pure decision-mapping helper)

**Interfaces:**
- Consumes: `ReviewFn`/`ReviewDecision`/`autoAcceptReview` + `scaffoldCharacter` (Task 4); `modelServiceLayer` (`cli.ts:43`); `@effect/cli` `Prompt`.
- Produces: `reviewDecisionFromAnswer(answer: "accept" | "edit" | "regenerate" | "skip", original: string, edited: string, feedback: string): ReviewDecision` (pure helper in `guided-setup.ts`, exported for test).

- [ ] **Step 1: Write the failing test**

Create `apps/roci/src/setup/review.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { reviewDecisionFromAnswer } from "./guided-setup.js"

describe("reviewDecisionFromAnswer", () => {
  it("accept keeps the original content", () => {
    expect(reviewDecisionFromAnswer("accept", "orig", "ignored", "")).toEqual({ action: "accept", content: "orig" })
  })
  it("edit accepts the edited content", () => {
    expect(reviewDecisionFromAnswer("edit", "orig", "edited!", "")).toEqual({ action: "accept", content: "edited!" })
  })
  it("regenerate carries trimmed feedback, undefined when blank", () => {
    expect(reviewDecisionFromAnswer("regenerate", "o", "o", "  do better ")).toEqual({ action: "regenerate", feedback: "do better" })
    expect(reviewDecisionFromAnswer("regenerate", "o", "o", "   ")).toEqual({ action: "regenerate", feedback: undefined })
  })
  it("skip", () => {
    expect(reviewDecisionFromAnswer("skip", "o", "o", "")).toEqual({ action: "skip" })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/roci/src/setup/review.test.ts`
Expected: FAIL ("reviewDecisionFromAnswer is not exported").

- [ ] **Step 3: Add the helper + `interactiveReview` to `guided-setup.ts`**

Add imports at the top (alongside the existing `scaffoldCharacter` import):

```typescript
import { scaffoldCharacter, type ReviewDecision } from "@roci/core/core/character-scaffold.js"
import type { IdentityStep } from "@roci/core/core/identity-gen/prompts.js"
```

Add the pure helper and the interactive review near the top of the module (after `logProcMsg`):

```typescript
/** Map a review answer + text fields to a ReviewDecision (pure; unit-tested). */
export const reviewDecisionFromAnswer = (
  answer: "accept" | "edit" | "regenerate" | "skip",
  original: string,
  edited: string,
  feedback: string,
): ReviewDecision => {
  switch (answer) {
    case "accept":
      return { action: "accept", content: original }
    case "edit":
      return { action: "accept", content: edited }
    case "regenerate":
      return { action: "regenerate", feedback: feedback.trim() || undefined }
    case "skip":
      return { action: "skip" }
  }
}

/** Interactive per-step review: show the artifact, ask accept/edit/regenerate/skip. */
const interactiveReview = (step: IdentityStep, content: string) =>
  Effect.gen(function* () {
    yield* logToConsole("setup", "cli", `\n----- ${step} -----\n${content}\n-----------------`)
    const answer = yield* Prompt.select({
      message: `Review ${step}`,
      choices: [
        { title: "Accept", value: "accept" as const },
        { title: "Edit", value: "edit" as const },
        { title: "Regenerate (with feedback)", value: "regenerate" as const },
        { title: "Skip (use plain template)", value: "skip" as const },
      ],
    })
    let edited = content
    let feedback = ""
    if (answer === "edit") {
      edited = yield* Prompt.text({ message: "Edit the content", default: content })
    } else if (answer === "regenerate") {
      feedback = yield* Prompt.text({ message: "Feedback to steer the re-roll (optional)", default: "" })
    }
    return reviewDecisionFromAnswer(answer, content, edited, feedback)
  })
```

Update the `scaffoldCharacter` call inside the character loop — drop nothing it relied on, but remove no longer-valid args and pass the review:

```typescript
        const { results: _scaffoldResults, summary } = yield* scaffoldCharacter({
          projectRoot,
          characterName: name,
          identityTemplate: domainConfig.identityTemplate,
          characterDescription: charDescription.trim() || undefined,
          domainConfig,
          review: interactiveReview,
        })
```

(There is no `models` argument anymore; `cortexModels` defaults to `DEFAULT_CORTEX_MODELS` inside the scaffolder.)

- [ ] **Step 4: Provide `modelServiceLayer` to the setup command in `cli.ts`**

The setup command currently builds without `ModelService`. Add it so the resident conscious server cold-loads during setup. Find the `setupCommand` definition (`apps/roci/src/cli.ts:383`) and add `Command.provide(modelServiceLayer)` to its `.pipe(...)` (the same `modelServiceLayer` defined at `cli.ts:43` and already applied to `startCommand`):

```typescript
).pipe(
  Command.provide(modelServiceLayer),
  Command.withDescription("Set up character(s) for a domain — create files and config"),
)
```

Also update the non-interactive `setup --domain` branch call to `scaffoldCharacter` (around `cli.ts:425-437`) — drop `models: DEFAULT_MODEL_CONFIG` and pass `autoAcceptReview`:

```typescript
    const { summary } = yield* scaffoldCharacter({
      projectRoot: PROJECT_ROOT,
      characterName: charName,
      identityTemplate: domainConfig.identityTemplate,
      domainConfig,
      review: autoAcceptReview,
    })
```

Add `autoAcceptReview` to the existing `scaffoldCharacter` import from `@roci/core` in `cli.ts`.

- [ ] **Step 5: Run the helper test to verify it passes**

Run: `pnpm vitest run apps/roci/src/setup/review.test.ts`
Expected: PASS.

- [ ] **Step 6: Build the app to confirm wiring + types**

Run: `pnpm nx run roci:build`
Expected: `tsc` passes. If `Prompt.select` is reported missing, it is exported by `@effect/cli`'s `Prompt` module the same way `Prompt.text`/`Prompt.multiSelect` are (`guided-setup.ts:41,84`); confirm the import is the same `Prompt` namespace.

- [ ] **Step 7: Commit**

```bash
git add apps/roci/src/setup/guided-setup.ts apps/roci/src/setup/review.test.ts apps/roci/src/cli.ts
git commit -m "feat(setup): interactive per-step review wired to local scaffolder

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Gated live smoke + model-evaluation notes

**Files:**
- Create: `packages/core/src/core/identity-gen/generate.smoke.test.ts` (gated, like the existing mlx smokes)
- Create: `docs/identity-gen-eval.md` (how to evaluate output to compare model choices — per the spec's reporting requirement)

**Interfaces:**
- Consumes: `generateArtifact`, `buildBackgroundPrompt`, `ModelClientLive`, `ModelServiceLive` + `modelBackendLayer`.

- [ ] **Step 1: Write the gated smoke test**

Create `packages/core/src/core/identity-gen/generate.smoke.test.ts`. It runs only when `ROCI_IDENTITY_SMOKE=1` and a conscious mlx server is reachable; otherwise it is skipped (mirror the gating style of `services/*.smoke.test.ts`):

```typescript
import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { ModelClientLive } from "../../model/client.js"
import { ModelServiceLive, ModelBackendTag } from "../../services/ModelService.js"
import { makeMlxBackend } from "../../services/mlx-backend.js"
import { buildBackgroundPrompt } from "./prompts.js"
import { generateArtifact } from "./generate.js"

const gated = process.env.ROCI_IDENTITY_SMOKE === "1" ? describe : describe.skip

gated("generateArtifact (live conscious tier)", () => {
  it("produces non-trivial background prose", async () => {
    const modelBackendLayer = Layer.effect(ModelBackendTag, makeMlxBackend())
    const layers = Layer.mergeAll(ModelClientLive, ModelServiceLive.pipe(Layer.provide(modelBackendLayer)))
    const prompt = buildBackgroundPrompt({
      characterName: "Smoke",
      characterDescription: "a wry archivist who hoards forbidden star-charts",
    })
    const text = await Effect.runPromise(
      Effect.scoped(Effect.provide(generateArtifact("background", prompt), layers)),
    )
    expect(text.length).toBeGreaterThan(200)
  }, 240_000)
})
```

- [ ] **Step 2: Verify it skips by default**

Run: `pnpm vitest run packages/core/src/core/identity-gen/generate.smoke.test.ts`
Expected: PASS with the suite SKIPPED (no `ROCI_IDENTITY_SMOKE`).

- [ ] **Step 3: Run it for real once (manual; needs the venv + a conscious server)**

Run (from a shell with `mlx_lm.server` on PATH, e.g. `source ~/llm-env/bin/activate.fish`):
`env ROCI_IDENTITY_SMOKE=1 pnpm vitest run packages/core/src/core/identity-gen/generate.smoke.test.ts`
Expected: PASS — prints/returns >200 chars of background prose from the conscious model. Capture the output for the eval notes.

- [ ] **Step 4: Write `docs/identity-gen-eval.md`**

Document how to judge identity-gen output so alternate conscious-model choices can be compared. Include:
- the gated smoke command above as the harness for a one-shot sample;
- the per-artifact quality rubric (background: description-specific + 300-800 words + coherent voice; values: 5-10 concrete non-platitude values grounded in the background; palette: 4-6 rows of exactly 5 emoji with `→` gloss; diary: a structure that reflects the values, not a generic stub; summary: 4 sentences);
- the procedure to compare models: change the conscious handle (`DEFAULT_CORTEX_MODELS.conscious` in `packages/core/src/model/handles.ts:92` or a `CortexModelOverlay`), re-run the smoke for the same description, and score each artifact against the rubric;
- a note that a full interactive run is `roci setup` (which now drives the wizard against the conscious tier).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/core/identity-gen/generate.smoke.test.ts docs/identity-gen-eval.md
git commit -m "test(identity-gen): gated live smoke + model-evaluation notes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] `pnpm nx run-many -t build` — all 4 projects compile.
- [ ] `pnpm test` — full suite green (new palette/prompts/generate/scaffold/review tests included; smoke skipped).
- [ ] Manual: `roci setup` (interactive) creates a `qa-demo-*` character end-to-end against the local conscious tier — accept/edit/regenerate/skip each work, files land in `players/<name>/me/`, palette is gradient-form, diary has a character-fit structure, and a model-down condition produces a hard error (not boilerplate).

## Self-review notes (author)

- **Spec coverage:** local-only conscious-tier generation (T3), no-container/no-Claude (T3/T4 drop the deps), hard-fail no silent fallback (T3 `EmptyGenerationError`, T4 only-skip-makes-templates), per-step accept/edit/regenerate/skip (T4 loop + T5 UI), gradient palette (T1), model-designed diary w/ 8 examples (T2 `buildDiaryPrompt`), conscious model = same as running loop (T3 `resolveHandle(DEFAULT_CORTEX_MODELS,"conscious")`), eval notes for comparing models (T6). Non-interactive path explicitly out of scope (kept compiling via `autoAcceptReview`).
- **Types:** `ReviewFn`/`ReviewDecision`/`IdentityStep`/`IdentityContext`/`generateArtifact`/`EmptyGenerationError` names are consistent across T2-T5. The requirements channel `ModelClient | ModelService` is consistent T3→T4→T5.
- **Known soft spot:** `Prompt.select` availability is asserted from the `@effect/cli` `Prompt` namespace; T5 Step 6 calls it out to confirm at build.
