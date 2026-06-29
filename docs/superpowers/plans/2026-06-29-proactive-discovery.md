# Proactive Discovery Implementation Plan

> **For agentic workers — REQUIRED SUB-SKILL.** Before executing this plan you MUST read one of:
> - [ ] `superpowers:subagent-driven-development` — if executing in THIS session by dispatching a subagent per task (recommended).
> - [ ] `superpowers:executing-plans` — if executing in a SEPARATE session with review checkpoints.

**Status:** Transcription of the approved design at `docs/superpowers/specs/2026-06-29-core-prompts-discovery-design.md`. Faithful — no redesign, no added scope.
**Date:** 2026-06-29

## Goal

Give the agent a way to learn its environment, its capabilities, and the paths open to it by probing the live world — via an orient `confidence` signal, a decide `discover` action, and a domain discovery rubric.

## Architecture

Orient emits a single minimal `confidence` scalar. Decide gains a `discover` action whose result is translated by a pure `discoverToPlan` helper into a synthetic one-step plan, reusing the existing step→evaluate execution path (hybrid-C — essentially no new loop machinery). SpaceMolt composes a markdown discovery rubric into its persistent acting prompt at load time via `renderTemplate`.

## Tech Stack

TypeScript, Effect, vitest, markdown prompt templates with `{{slot}}` rendering via `renderTemplate` (`packages/core/src/core/template.ts:53`).

## Global Constraints

1. **Forebrain/orient is parse-fragile.** It runs thinking-off + `maxTokens: 1024` (`packages/core/src/model/handles.ts:106-107`; guarded by `packages/core/src/model/handles.test.ts:39,78`). Orient's output gains **EXACTLY ONE** new scalar field (`confidence`) — no nested structure. The richer "what I don't know yet" detail rides inside the **existing** `sections[]` array.
2. **No code in `packages/domain-github`.** GitHub discovery realization is deferred — the domain is being revised separately.
3. **Follow existing patterns.** Co-located vitest tests (`*.test.ts` next to source); the shared discovery rubric is **markdown** living for now in SpaceMolt's own prompts dir (`packages/domain-spacemolt/src/prompts/discovery-rubric.md`), composed at load time via `renderTemplate`. Promote the rubric to a core-shared asset when a second domain needs it (deferred with GitHub).

### Scope

- **IN SCOPE:** the core OODA skills + loop (`packages/core/src/skills`, `packages/core/src/cortex`), and the **SpaceMolt** domain only.
- **OUT OF SCOPE:** the **GitHub** domain. **GitHub discovery realization is deferred — the domain is being revised separately.** No task here touches `packages/domain-github`.
- **Rubric home:** the shared discovery rubric is MARKDOWN. For now it lives in SpaceMolt's own prompts dir (`packages/domain-spacemolt/src/prompts/discovery-rubric.md`), composed at load time via `renderTemplate`. **Promote the rubric to a core-shared asset when a second domain needs it (deferred with GitHub).**

### Test commands

- Full suite: `pnpm test` (which runs `vitest --run`; see `package.json:8`).
- One file: `pnpm vitest run <path>` (e.g. `pnpm vitest run packages/core/src/cortex/state.test.ts`). Adjust to `pnpm exec vitest run <path>` if the bare form is not resolvable in your shell.
- Typecheck / build: `pnpm typecheck` (`nx run-many -t typecheck`) or `pnpm build` (`nx run-many -t build`). Note: vitest does **not** typecheck, so a required-field addition can leave `pnpm test` green while `pnpm typecheck` fails — run both.

---

## Task 1 — `confidence` field on `OrientResult`

**TDD order:** add the field + fallback default → fix the two existing typed `OrientResult` fixtures so typecheck stays green → write the merge-default test → run → commit.

### 1a. `packages/core/src/skills/types.ts` — add the field

Replace the current `OrientResult` interface (`:24-35`) with:

```ts
/**
 * Result of the orient skill — structured situation assessment.
 */
export interface OrientResult {
  readonly headline: string
  readonly sections: ReadonlyArray<{
    readonly id: string
    readonly heading: string
    readonly body: string
  }>
  readonly whatChanged: string
  /** Emotional state — carried forward from observe, potentially amplified. */
  readonly emotionalState: string
  /** Self-assessed footing in the world. Low = flying blind (unknown tools /
   *  affordances / paths) → biases the decider toward `discover`. */
  readonly confidence: "low" | "medium" | "high"
  readonly metrics: Record<string, string | number | boolean>
}
```

### 1b. `packages/core/src/cortex/tiers.ts` — default the fallback to `low`

Replace `orientFallback` (`:109-115`) with (add `confidence: "low"` — a safe default: unknown situation → low → biases toward discovery):

```ts
const orientFallback = (emotionalWeight: string): OrientResult => ({
  headline: "Orient parse failure — situation unknown",
  sections: [],
  whatChanged: "Unknown — forebrain could not parse",
  emotionalState: emotionalWeight,
  confidence: "low",
  metrics: {},
})
```

The merge path in `runForebrain` (`:148-152`) already does `{ ...fallback, ...parsed.value }`, so a model that omits `confidence` inherits `"low"` automatically — no other change to `runForebrain`.

### 1c. Fix existing typed `OrientResult` fixtures (required to keep typecheck green)

Adding a required field breaks two **typed** literals. (A third, `smoke.test.ts:278`, casts `JSON.parse(...)` — which is `any` — so it is unaffected.)

In `packages/core/src/cortex/state.test.ts`, the `formatSteerDirective` fixture (`:122-132`) — add `confidence`:

```ts
  const orient: OrientResult = {
    headline: "Login flow broken after auth refactor",
    whatChanged: "OAuth redirect URL changed",
    emotionalState: "😟",
    confidence: "medium",
    sections: [
      { id: "s1", heading: "Impact", body: "Users cannot log in." },
      { id: "s2", heading: "Priority", body: "Fix immediately." },
    ],
    metrics: { errors: 42 },
  }
```

In `packages/core/src/cortex/tiers.test.ts`, the `base` orient fixture (`:270-275`) used by `runConsciousDecide` tests — add `confidence`:

```ts
  const base = {
    headline: "h",
    whatChanged: "w",
    emotionalState: "😐",
    confidence: "low" as const,
    metrics: {},
  }
```

### 1d. Test — merge fills `confidence` from the fallback when the model omits it

`orientFallback` is **private** (not exported). The lower-friction faithful option, which mirrors the existing `runForebrain` stub-model tests in `tiers.test.ts`, is to **add an assertion to the `runForebrain` describe block** (no export needed). Append inside `describe("runForebrain", …)` (after the existing `:149-162` test):

```ts
  it("fills confidence from the fallback when the model omits it (merge default = low)", async () => {
    const out = await Effect.runPromise(
      Effect.provide(
        runForebrain(config, ["e1"], "{}", { background: "", values: "", diary: "" }, "😐"),
        Layer.mergeAll(
          fixedClient('{"headline":"x","sections":[],"whatChanged":"y","emotionalState":"😐","metrics":{}}'),
          recordingService([]),
          silentLog,
        ),
      ),
    )
    expect(out.confidence).toBe("low")
  })
```

### Verify & commit

- `pnpm vitest run packages/core/src/cortex/tiers.test.ts` — the new test **fails** before 1a/1b (no `confidence` field → `out.confidence` is `undefined`), **passes** after.
- `pnpm vitest run packages/core/src/cortex/state.test.ts` green.
- `pnpm typecheck` clean (proves 1c fixtures fixed).
- Commit.

---

## Task 2 — `discover` variant on `DecideResult` + `discoverToPlan` helper

### 2a. `packages/core/src/skills/types.ts` — extend the union

Replace the `DecideResult` union (`:52-60`) with (adds the `discover` variant as the fifth member):

```ts
export type DecideResult =
  | {
      readonly decision: "plan"
      readonly reasoning: string
      readonly steps: ReadonlyArray<PlanStep>
    }
  | { readonly decision: "continue"; readonly reasoning: string }
  | { readonly decision: "wait"; readonly reasoning: string; readonly wait: WaitState }
  | { readonly decision: "terminate"; readonly reasoning: string; readonly summary: string }
  | {
      readonly decision: "discover"
      readonly reasoning: string
      readonly discover: {
        readonly questions: ReadonlyArray<string>
        readonly tier: "fast" | "smart"
        readonly timeoutTicks: number
      }
    }
```

### 2b. `packages/core/src/cortex/state.ts` — add the pure helper

`state.ts` already imports `DecideResult` (`:1`) and `PlanStep` (`:2`) — **no new imports needed**. Add after `decideSteps` (`:55`):

```ts
/**
 * Translate a `discover` decision into a synthetic one-step `plan` decision so it
 * reuses the existing step→evaluate execution path (hybrid-C — no new loop
 * machinery). The single step's `task` is "discover"; the questions become its
 * goal; tier and timeoutTicks carry straight through to the step's fields.
 */
export function discoverToPlan(
  decide: Extract<DecideResult, { decision: "discover" }>,
): DecideResult {
  return {
    decision: "plan",
    reasoning: decide.reasoning,
    steps: [
      {
        task: "discover",
        goal: `Discover your world. Answer: ${decide.discover.questions.join("; ")}`,
        tier: decide.discover.tier,
        successCondition:
          "Findings on environment, capabilities, and available paths reported back.",
        timeoutTicks: decide.discover.timeoutTicks,
      },
    ],
  }
}
```

`PlanStep` shape is `{ task, goal, tier, successCondition, timeoutTicks }` (`packages/core/src/core/types.ts:15-21`) — matched exactly above.

### 2c. Test — `state.test.ts`

Add `discoverToPlan` to the existing import block (`:2-11`):

```ts
import {
  freshCortexState,
  shouldForceOrient,
  formatStepTask,
  planSteps,
  decideSteps,
  discoverToPlan,
  STEP_DONE_MARKER,
  detectCompletion,
  formatSteerDirective,
} from "./state.js"
```

Add a new describe block (mirrors the `planSteps`/`decideSteps` tests at `:45-92`):

```ts
describe("discoverToPlan", () => {
  it("translates a discover decision into a single-step discover plan", () => {
    const decide = {
      decision: "discover" as const,
      reasoning: "flying blind at cold start",
      discover: {
        questions: ["what can my CLI do?", "where are the docs?"],
        tier: "fast" as const,
        timeoutTicks: 3,
      },
    }
    const plan = discoverToPlan(decide)
    const steps = planSteps(plan)
    expect(steps).toHaveLength(1)
    expect(steps[0].task).toBe("discover")
    expect(steps[0].tier).toBe("fast")
    expect(steps[0].timeoutTicks).toBe(3)
    expect(steps[0].goal).toContain("what can my CLI do?")
    expect(steps[0].goal).toContain("where are the docs?")
  })
})
```

### Verify & commit

- `pnpm vitest run packages/core/src/cortex/state.test.ts` — **fails** before 2b (no `discoverToPlan` export), **passes** after.
- `pnpm typecheck` clean.
- Commit.

---

## Task 3 — Wire the `discover` decision into the loop

### 3a. `packages/core/src/cortex/loop.ts` — import + new branch

Add `discoverToPlan` to the `./state.js` import group (`:32-42`):

```ts
import {
  freshCortexState,
  shouldForceOrient,
  planSteps,
  decideSteps,
  discoverToPlan,
  formatStepTask,
  formatExecutionReport,
  formatSteerDirective,
  detectCompletion,
  STEP_DONE_MARKER,
} from "./state.js"
```

Replace the idle-path decision handling (`:239-253`) with the version below. The new `discover` branch sits between the `wait` branch and the `plan` else-if (all branch on `decide.decision`, mutually exclusive):

```ts
          if (decide.decision === "terminate") return { _tag: "Completed" as const, finalState: state }
          if (decide.decision === "wait") {
            cortex.waitState = decide.wait
            if (decide.wait.disposition === "terminate")
              return { _tag: "Completed" as const, finalState: state }
          } else if (decide.decision === "discover") {
            // Discover reuses the plan/step path: translate to a synthetic
            // one-step plan and run it through the existing step executor.
            cortex.currentPlan = discoverToPlan(decide)
            cortex.currentStepIndex = 0
            planHeadline = orient.headline
          } else if (decideSteps(decide).length > 0) {
            // decideSteps is array-safe: a parseable `{"decision":"plan"}` with
            // a missing/non-array/empty `steps` yields [] here (parseOr's
            // fallback is the `continue` variant, so `decide.steps` can be
            // undefined). A plan with no actionable steps is treated as no plan
            // started — never a crash on `decide.steps.length`.
            cortex.currentPlan = decide
            cortex.currentStepIndex = 0
            planHeadline = orient.headline
          }
```

### 3b. Test — `loop.test.ts`

`loop.test.ts` is integration-style (it drives the whole `runCortex` through scripted `ModelClient` layers), but a focused test **is tractable** in that exact style. Add this test inside `describe("runCortex (conscious-session executor)", …)`, reusing the file's existing `fakeDomain` / `fakeIo` / `fakeRuntimeDeps` / `noopModelService` layers and `ConsciousThoughtTest`:

```ts
  it("a discover decision becomes a one-step 'discover' plan that executes", async () => {
    const capturedPrompts: string[] = []
    const discoverClient = Layer.succeed(
      ModelClient,
      ModelClient.of({
        complete: (_h: ModelHandle, messages) =>
          Effect.sync(() => {
            const p = messages.map((m) => m.content).join(" ").toLowerCase()
            const hasDisposition = p.includes("disposition")
            const hasDecision = p.includes("decision")
            const hasHeadline = p.includes("headline")
            const hasJudgment = p.includes("judgment")
            if (hasDisposition && !hasDecision)
              return { text: '{"disposition":"escalate","emotionalWeight":"😰","reason":"x"}', raw: {} }
            if (hasJudgment && !hasHeadline)
              return {
                text: '{"judgment":"succeeded","reasoning":"learned","transition":{"transition":"terminate","summary":"done"}}',
                raw: {},
              }
            if (hasHeadline && !hasJudgment)
              return {
                text: '{"headline":"cold start — unknown world","sections":[],"whatChanged":"x","emotionalState":"😰","confidence":"low","metrics":{}}',
                raw: {},
              }
            // decide → discover
            return {
              text: '{"decision":"discover","reasoning":"flying blind","discover":{"questions":["what can my CLI do?","where are the docs?"],"tier":"fast","timeoutTicks":2}}',
              raw: {},
            }
          }),
      }),
    )
    const ctLayer = ConsciousThoughtTest((config, _resume) => {
      capturedPrompts.push(config.prompt)
      return {
        result: { output: `probed ${STEP_DONE_MARKER}`, timedOut: false, durationMs: 5 },
        sessionId: "ses_discover",
      }
    })
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "boot" })
      return yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        cadence: "real-time",
        orientInterval: 1,
        tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(discoverClient, ctLayer, fakeDomain, fakeIo, fakeRuntimeDeps, noopModelService)))
    })
    const result = await Effect.runPromise(program)
    expect(result._tag).toBe("Completed")
    // The executed step was the synthetic discover step (formatStepTask emits "# Task: discover").
    expect(capturedPrompts.some((p) => p.includes("# Task: discover"))).toBe(true)
  }, 20_000)
```

This exercises the full translation: discover decision → `discoverToPlan` → one-step plan → the existing step executor dispatches `formatStepTask(step, …)` (`state.ts:90-98`, which emits `# Task: ${step.task}` = `# Task: discover`) → done-marker → evaluate → terminate → `Completed`.

### Verify & commit

- `pnpm vitest run packages/core/src/cortex/loop.test.ts` — the new test **fails** before 3a (a `discover` decision falls through every branch: not terminate/wait, and `decideSteps` returns `[]` for a non-plan decision, so no plan is ever set → the loop never completes / the discover step never runs), **passes** after.
- `pnpm typecheck` clean.
- Commit.

---

## Task 4 — `orient.md`: `confidence` field + instruction

No automated test (prompt content). Verification = `pnpm typecheck` clean + `runForebrain` still parses (the merge tolerates the added field; Task 1d covers the merge).

### 4a. `packages/core/src/skills/orient.md` — add field to the output JSON

In the output JSON block (`:52-68`), add the `confidence` line between `emotionalState` and `metrics`:

```json
{
  "headline": "<one-sentence summary of the current situation>",
  "sections": [
    {
      "id": "<stable-id>",
      "heading": "<section heading>",
      "body": "<relevant context, curated>"
    }
  ],
  "whatChanged": "<delta since last orientation>",
  "emotionalState": "<emoji string — carried forward from observations, potentially amplified>",
  "confidence": "low | medium | high",
  "metrics": {
    "<key>": "<value>"
  }
}
```

### 4b. `packages/core/src/skills/orient.md` — ~2 lines of instruction

In the `## Instructions` section, after the existing `Consider:` bullet list (after `:45`), add:

```markdown
Assess not just the world but the agent's own footing in it. If it doesn't yet know its tools, the world's affordances, or the paths open to it, say so — surface those gaps as an optional **"Open questions"** entry inside `sections[]` — and set `confidence` accordingly. A cold start (little grounding in the live world) is normally **low** confidence.
```

### Verify & commit

- `pnpm typecheck` clean.
- Manual note: the forebrain merge (`tiers.ts:148-152`) tolerates the new field whether the model emits it or not; Task 1d already asserts the omit-path default.
- Commit.

---

## Task 5 — `decide.md`: `discover` action + use `confidence`

### 5a. `packages/core/src/cortex/tiers.ts` — pass `confidence` to the render

In `runConsciousDecide`, the `skills.decide.render({…})` call (`:178-193`) — add `confidence: orient.confidence`. Updated render vars:

```ts
  const prompt = skills.decide.render({
    cadence: config.cadence,
    cadenceGuidance: getCadenceGuidance("decide", config.cadence),
    headline: orient.headline,
    whatChanged: orient.whatChanged,
    emotionalState: orient.emotionalState,
    confidence: orient.confidence,
    // Defensive: a malformed OrientResult (non-array/absent `sections`) must
    // never crash the decide builder. runForebrain normalizes this, but guard
    // here too in case an orient result is constructed elsewhere.
    sections: (Array.isArray(orient.sections) ? orient.sections : [])
      .map((s) => `#### ${s.heading}\n${s.body}`)
      .join("\n\n"),
    metrics: JSON.stringify(orient.metrics, null, 2),
    currentPlanState,
    availableSkills: availableActions,
  })
```

(`orient.confidence` exists on `OrientResult` after Task 1 — this is why Task 5 must follow Task 1.)

### 5b. `packages/core/src/skills/decide.md` — surface `{{confidence}}`

In the `## Situation Assessment` block, add a `### Confidence` line. Replace `:14-29`:

```markdown
## Situation Assessment

### Headline
{{headline}}

### What Changed
{{whatChanged}}

### Confidence
{{confidence}}

### Emotional State
{{emotionalState}}

{{sections}}

### Metrics
{{metrics}}
```

### 5c. `packages/core/src/skills/decide.md` — add the `discover` action

In `## Instructions`, change the opener (`:40`) from "one of four actions" to "one of five actions", and add a `### Discover` subsection. After the `### Terminate` description (`:54-55`):

```markdown
### Discover
You don't yet know enough to plan well — your footing is uncertain. Probe the live world to learn your environment, your capabilities, and the paths open to you. Name the questions you need answered, pick a model tier, and budget a time. Report findings back; don't act on them in the same pass.

When the situation assessment reports **low confidence** or unresolved open questions about your environment / capabilities / paths — especially at session start — prefer `discover` over a speculative plan. **Discovery is cheap; acting blind is not.**
```

Then add its JSON shape after the `**Terminate:**` block (`:97-104`), as a fifth shape under "Respond with ONLY one of these JSON shapes":

```markdown
**Discover:**
```json
{
  "decision": "discover",
  "reasoning": "<why I don't know enough to plan well>",
  "discover": {
    "questions": ["<what I need to learn>", "..."],
    "tier": "fast | smart",
    "timeoutTicks": <number>
  }
}
```
```

### Verify & commit

- `pnpm typecheck` clean (the `confidence` render var requires the `OrientResult.confidence` field added in Task 1).
- `pnpm vitest run packages/core/src/skills/smoke.test.ts` green — the existing `decide` render test (`smoke.test.ts:166-194`) does not pass a `confidence` var, so `{{confidence}}` renders to the empty string; its `expect(rendered).not.toMatch(/\{\{\w+\}\}/)` assertion still holds (no leftover placeholder).
- Commit.

---

## Task 6 — SpaceMolt discovery rubric + composition

### 6a. New file `packages/domain-spacemolt/src/prompts/discovery-rubric.md`

The 6-step rubric from spec §6 with the four `{{slots}}`. **No YAML frontmatter** (it is composed by `loadTemplateSync`, which strips frontmatter if present, then `renderTemplate`). Full file:

```markdown
## Discovering your world

When you've been asked to discover, or you're unsure what's possible, work through this — don't act on findings in the same pass unless trivial; report them so your next orientation can use them.

1. **Locate yourself** — where am I? List the workspace; read any README, CLAUDE.md, or docs present ({{whereDocsLive}}).
2. **Inventory your tools** — what can I run? Check {{primaryTools}} and read their `--help`/usage. Don't assume; confirm.
3. **Read the world state** — what's true right now? ({{statusCommands}})
4. **Enumerate actions** — what can I actually do from here? Separate always-available actions from ones gated by state or cost.
5. **Name the paths** — given what you found, name 2–4 distinct directions you could pursue right now ({{pathExamples}}).
6. **Note the edges** — what failed, what's blocked, what's still unknown. Carry these forward as open questions.
```

(The build step `tsc && node scripts/copy-assets.js` already copies every non-`.ts` file under `src/` into `dist/` recursively — `scripts/copy-assets.js` — so the new `.md` is picked up automatically; no build-config change needed.)

### 6b. `packages/domain-spacemolt/src/prompt-builder.ts` — compose at load time

Add `renderTemplate` to the existing template import (`:10`):

```ts
import { stripFrontmatter, renderTemplate } from "@roci/core/core/template.js"
```

(`renderTemplate` is exported from `packages/core/src/core/template.ts:53`, the same module the builder already imports `stripFrontmatter` from.)

Replace the layer (`:78-88`) with:

```ts
/** Layer providing the SpaceMolt prompt builder. */
export const SpaceMoltPromptBuilderLive = Layer.succeed(
  PromptBuilderTag,
  (() => {
    const inGameClaudeMd = loadTemplateSync(path.join(PROMPTS_DIR, "in-game-claude.md"))
    const discoveryRubric = renderTemplate(
      loadTemplateSync(path.join(PROMPTS_DIR, "discovery-rubric.md")),
      {
        primaryTools: "`spacemolt` CLI",
        whereDocsLive: "in-game docs and the forum",
        statusCommands: "the game-state command",
        pathExamples: "build a fleet, gather resources, combat, or alliance/social play",
      },
    )
    const inGameWithDiscovery = `${inGameClaudeMd}\n\n${discoveryRubric}`
    return {
      ...makePromptBuilder(),
      systemPrompt: (_mode: string, _task: string) => inGameWithDiscovery,
    }
  })(),
)
```

### 6c. Test — new `packages/domain-spacemolt/src/prompt-builder.test.ts`

The builder is a `Layer.succeed(PromptBuilderTag, …)`, so resolve the tag through Effect and call `systemPrompt` (no refactor needed):

```ts
import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import { SpaceMoltPromptBuilderLive } from "./prompt-builder.js"
import { PromptBuilderTag } from "@roci/core/core/prompt-builder.js"

describe("SpaceMoltPromptBuilderLive — systemPrompt composes the discovery rubric", () => {
  it("includes the rubric and fills SpaceMolt slots", async () => {
    const prompt = await Effect.runPromise(
      Effect.gen(function* () {
        const builder = yield* PromptBuilderTag
        return builder.systemPrompt("select", "")
      }).pipe(Effect.provide(SpaceMoltPromptBuilderLive)),
    )
    // Rubric composed in (distinctive line from discovery-rubric.md).
    expect(prompt).toContain("Discovering your world")
    // Slot filled with the SpaceMolt-specific value (proves composition + slot fill).
    expect(prompt).toContain("`spacemolt` CLI")
  })
})
```

### Verify & commit

- `pnpm vitest run packages/domain-spacemolt/src/prompt-builder.test.ts` — **fails** before 6a/6b (no rubric file / no composition), **passes** after.
- `pnpm typecheck` clean.
- Commit.

---

## Out of scope / follow-ups

- **GitHub discovery realization is deferred — the domain is being revised separately.** The spec's GitHub plan (a `systemPromptDiscover(task)` function + a `SYSTEM_PROMPT_BY_TASK.discover` entry in `packages/domain-github/src/prompt-builder.ts`, mirroring the `investigate`→ReadOnly pattern) is **not** implemented here. No task in this plan touches `packages/domain-github`.
- **Promote the rubric to a core-shared asset when a second domain consumes it.** It currently lives in `packages/domain-spacemolt/src/prompts/discovery-rubric.md`; when GitHub (or any second domain) needs it, lift it to a core-owned markdown asset both domains load.
- **Discover-decision loop wiring** is realized minimally here (Task 3) via `discoverToPlan` reusing the step→evaluate path. Any richer escalation tuning (e.g. `observe`/`cadence` tweaks so discovery findings escalate into the next orient — spec §10) remains a follow-up.
- **Stale `session-system-prompt.md` files** (`packages/domain-github/src/session-system-prompt.md` and `packages/domain-spacemolt/src/session-system-prompt.md`) appear unused by code (`grep -rn "session-system-prompt" packages --include="*.ts"` returns nothing) and are **deletion candidates** for a future cleanup pass — out of scope here.

---

## Execution handoff

Choose how to execute this plan:

1. **Subagent-Driven (recommended).** Use `superpowers:subagent-driven-development`: dispatch one subagent per task (1→6, in order — Task 5 depends on Task 1; Task 3 depends on Task 2). The controller reviews each task's diff + green test/typecheck output, then commits, before dispatching the next. Tasks are sequential (shared files: `types.ts`, `tiers.ts`, `state.ts`), so do **not** parallelize.
2. **Inline.** Execute each task yourself in this session, following strict TDD (failing test → minimal impl → green → commit) per task, per `superpowers:test-driven-development`.
