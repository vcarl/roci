# Cortex Tiers & Escalation Ladder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `cortex/` module — three near-pure tier functions (hindbrain/forebrain/conscious) running the existing OODA skill templates on local models via `ModelClient`, plus `runCortex`, the escalation-ladder loop that executes plan steps by delegating to `Cybernetics`.

**Architecture:** The tiers are the four `ooda-runner` functions repointed from `runTurn`(Claude) to `ModelClient`(local), reusing the `observe/orient/decide/evaluate` skill templates and the `ObserveResult`/`OrientResult`/`DecideResult`/`EvaluateResult` types. The loop mirrors `channel-session`'s structure but, instead of pushing channel events into a persistent session, it forks a `Cybernetics.delegate` fiber per plan step (the worker runs to completion in Docker), keeps ticking the reflexes while it runs, evaluates the result when it returns, and aborts the fiber if a critical interrupt fires. Most ticks die in the hindbrain; only escalation reaches the expensive tiers.

**Tech Stack:** TypeScript (ESM, strict), Effect, vitest. Package: `@roci/core`. Depends on Plan 1 (`ModelClient`/`ModelHandle`/`resolveHandle`) and Plan 2 (`Cybernetics`).

**Scope note:** Plan 3 of 4. Additive: creates `packages/core/src/cortex/`. Does not modify the domains or delete the old engine — that is Plan 4. Mid-delegation abort is implemented via the fork-and-poll loop (a critical interrupt interrupts the running delegation fiber).

## Global Constraints

- ESM with explicit `.js` import extensions; vitest colocated `*.test.ts`; Effect typed error channel.
- Skill templates live at `packages/core/src/skills/{observe,orient,decide,evaluate}.md`; load via `loadSkillSync` and render with the SAME variable keys `ooda-runner.ts` uses (verbatim below). Templates dir resolves as `path.resolve(import.meta.dirname, "../skills")` from `cortex/`.
- Reused types (verbatim): `ObserveResult {disposition: "discard"|"accumulate"|"escalate"; emotionalWeight: string; reason: string}`; `OrientResult {headline; sections: {id,heading,body}[]; whatChanged; emotionalState; metrics: Record<string,string|number|boolean>}`; `DecideResult` = union on `decision` of `"plan"{reasoning, steps: PlanStep[]}` | `"continue"{reasoning}` | `"wait"{reasoning, wait: WaitState}` | `"terminate"{reasoning, summary}`; `EvaluateResult {judgment; reasoning; transition; diaryEntry?}`; `PlanStep {task; goal; tier:"fast"|"smart"; successCondition; timeoutTicks}`; `WaitState {waitingFor; resolutionSignal; disposition:"hold"|"terminate"}`; `Alert {priority:"critical"|"high"|"medium"|"low"; message; suggestedAction?; ruleName?}`.
- Tier functions depend on **`ModelClient` only** (logging happens in the loop). Their error channel is `ModelError` — a missing/unreachable model fails fast; a parse failure is caught and returns a safe default.
- Service Tags consumed by the loop (verbatim Tag names): `EventProcessorTag`, `SituationClassifierTag`, `InterruptRegistryTag`, `StateRendererTag`, `PromptBuilderTag` (for the worker system prompt), `CharacterFs`, plus `ModelClient` and `Cybernetics`, and `CharacterLog` for console logging.
- `SituationClassifier.summarize(state) → SituationSummary {situation; headline; sections; metrics}`. `InterruptRegistry.criticals(state, situation) → Alert[]`. `StateRenderer.richSnapshot(state)` / `.stateDiff(before, after)` / `.logStateBar(name, metrics)`. `PromptBuilder.systemPrompt("select", "")` (the call channel-session used).

---

### Task 1: JSON parse helper + cortex tier functions

**Files:**
- Create: `packages/core/src/cortex/parse.ts`
- Create: `packages/core/src/cortex/tiers.ts`
- Test: `packages/core/src/cortex/tiers.test.ts`

**Interfaces:**
- Consumes: `ModelClient`, `ChatMessage` from `../model/client.js`; `resolveHandle`, `CortexModelConfig` from `../model/handles.js`; `ModelError` from `../model/errors.js`; `loadSkillSync` from `../skills/loader.js`; `getCadenceGuidance`, `Cadence` from `../skills/cadence.js`; `ObserveResult`/`OrientResult`/`DecideResult`/`EvaluateResult`/`WaitState` from `../skills/types.js`; `CharacterConfig` from `../services/CharacterFs.js`.
- Produces:
  - `function extractJson(text: string): string`
  - `function parseOr<T>(text: string, fallback: T): T`
  - `interface CortexRunnerConfig { char: CharacterConfig; cadence: Cadence; models: CortexModelConfig }`
  - `interface EvaluateInput { task; goal; successCondition; ticksBudgeted; ticksConsumed; executionReport; stateDiff; conditionCheck; emotionalState; remainingSteps }` (all `string` except the two `*Budgeted`/`*Consumed` which are `number`)
  - `runHindbrain(config, events: string[], waitState: WaitState | null): Effect<ObserveResult, ModelError, ModelClient>`
  - `runForebrain(config, accumulatedEvents: string[], domainState: string, identity: {background; values; diary}, emotionalWeight: string): Effect<OrientResult, ModelError, ModelClient>`
  - `runConsciousDecide(config, orient: OrientResult, currentPlanState: string, availableActions: string): Effect<DecideResult, ModelError, ModelClient>`
  - `runConsciousEvaluate(config, input: EvaluateInput): Effect<EvaluateResult, ModelError, ModelClient>`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/cortex/tiers.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { ModelClient } from "../model/client.js"
import type { ModelHandle } from "../model/handles.js"
import { DEFAULT_CORTEX_MODELS } from "../model/handles.js"
import { extractJson, parseOr, runHindbrain, runForebrain, type CortexRunnerConfig } from "./tiers.js"

const config: CortexRunnerConfig = {
  char: { name: "ada", dir: "/work/players/ada/me" },
  cadence: "real-time",
  models: DEFAULT_CORTEX_MODELS,
}

// A ModelClient that returns a fixed body regardless of input.
const fixedClient = (text: string): Layer.Layer<ModelClient> =>
  Layer.succeed(
    ModelClient,
    ModelClient.of({ complete: (_h: ModelHandle) => Effect.succeed({ text, raw: {} }) }),
  )

describe("extractJson / parseOr", () => {
  it("unwraps a ```json fence", () => {
    expect(JSON.parse(extractJson('```json\n{"a":1}\n```'))).toEqual({ a: 1 })
  })
  it("parseOr returns the fallback on garbage", () => {
    expect(parseOr("not json", { ok: false })).toEqual({ ok: false })
  })
})

describe("runHindbrain", () => {
  it("parses an escalate disposition from the model", async () => {
    const out = await Effect.runPromise(
      Effect.provide(
        runHindbrain(config, ["type: combat\n{}"], null),
        fixedClient('{"disposition":"escalate","emotionalWeight":"😰","reason":"under fire"}'),
      ),
    )
    expect(out.disposition).toBe("escalate")
  })

  it("falls back to accumulate on unparseable output (never silently discards)", async () => {
    const out = await Effect.runPromise(
      Effect.provide(runHindbrain(config, ["x"], null), fixedClient("the model rambled")),
    )
    expect(out.disposition).toBe("accumulate")
    expect(out.reason).toMatch(/parse/i)
  })
})

describe("runForebrain", () => {
  it("parses a headline", async () => {
    const out = await Effect.runPromise(
      Effect.provide(
        runForebrain(config, ["e1"], "{}", { background: "", values: "", diary: "" }, "😐"),
        fixedClient('{"headline":"Two PRs need review","sections":[],"whatChanged":"x","emotionalState":"😐","metrics":{}}'),
      ),
    )
    expect(out.headline).toContain("PRs")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/vcarl/workspace/roci && npx vitest run packages/core/src/cortex/tiers.test.ts`
Expected: FAIL — cannot find module `./tiers.js`.

- [ ] **Step 3: Write `parse.ts`**

Create `packages/core/src/cortex/parse.ts`:

```typescript
/** Extract JSON from model output that may be wrapped in a markdown code fence. */
export function extractJson(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  return match ? match[1].trim() : text.trim()
}

/** Parse JSON from model output, returning `fallback` if extraction/parse fails. */
export function parseOr<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(extractJson(text)) as T
  } catch {
    return fallback
  }
}
```

- [ ] **Step 4: Write `tiers.ts`**

Create `packages/core/src/cortex/tiers.ts`:

```typescript
import * as path from "node:path"
import { Effect } from "effect"
import { ModelClient } from "../model/client.js"
import type { ModelError } from "../model/errors.js"
import { resolveHandle, type CortexModelConfig } from "../model/handles.js"
import { loadSkillSync } from "../skills/loader.js"
import { getCadenceGuidance, type Cadence } from "../skills/cadence.js"
import type {
  ObserveResult,
  OrientResult,
  DecideResult,
  EvaluateResult,
  WaitState,
} from "../skills/types.js"
import type { CharacterConfig } from "../services/CharacterFs.js"
import { extractJson, parseOr } from "./parse.js"

export { extractJson, parseOr }

const SKILLS_DIR = path.resolve(import.meta.dirname, "../skills")
const skills = {
  observe: loadSkillSync(path.join(SKILLS_DIR, "observe.md")),
  orient: loadSkillSync(path.join(SKILLS_DIR, "orient.md")),
  decide: loadSkillSync(path.join(SKILLS_DIR, "decide.md")),
  evaluate: loadSkillSync(path.join(SKILLS_DIR, "evaluate.md")),
}

export interface CortexRunnerConfig {
  char: CharacterConfig
  cadence: Cadence
  models: CortexModelConfig
}

export interface EvaluateInput {
  task: string
  goal: string
  successCondition: string
  ticksBudgeted: number
  ticksConsumed: number
  executionReport: string
  stateDiff: string
  conditionCheck: string
  emotionalState: string
  remainingSteps: string
}

/** Run one prompt against the model backing `tier`, returning the raw text. */
const callTier = (config: CortexRunnerConfig, tier: "hindbrain" | "forebrain" | "conscious", prompt: string) =>
  Effect.gen(function* () {
    const client = yield* ModelClient
    const handle = resolveHandle(config.models, tier)
    const res = yield* client.complete(handle, [{ role: "user", content: prompt }])
    return res.text
  })

// ── Hindbrain (observe) ──────────────────────────────────────
export function runHindbrain(
  config: CortexRunnerConfig,
  events: string[],
  waitState: WaitState | null,
): Effect.Effect<ObserveResult, ModelError, ModelClient> {
  const prompt = skills.observe.render({
    cadence: config.cadence,
    cadenceGuidance: getCadenceGuidance("observe", config.cadence),
    events: events.map((e, i) => `[Event ${i + 1}] ${e}`).join("\n\n"),
    waitState: waitState
      ? `Waiting for: ${waitState.waitingFor}\nResolution signal: ${waitState.resolutionSignal}\nDisposition: ${waitState.disposition}`
      : "None — not currently waiting.",
  })
  return callTier(config, "hindbrain", prompt).pipe(
    Effect.map((text) =>
      parseOr<ObserveResult>(text, {
        disposition: "accumulate",
        emotionalWeight: "😐",
        reason: "parse failure — defaulting to accumulate",
      }),
    ),
  )
}

// ── Forebrain (orient) ───────────────────────────────────────
export function runForebrain(
  config: CortexRunnerConfig,
  accumulatedEvents: string[],
  domainState: string,
  identity: { background: string; values: string; diary: string },
  emotionalWeight: string,
): Effect.Effect<OrientResult, ModelError, ModelClient> {
  const prompt = skills.orient.render({
    cadence: config.cadence,
    cadenceGuidance: getCadenceGuidance("orient", config.cadence),
    accumulatedEvents: accumulatedEvents.join("\n\n"),
    domainState,
    background: identity.background,
    values: identity.values,
    diary: identity.diary,
    emotionalWeight,
  })
  return callTier(config, "forebrain", prompt).pipe(
    Effect.map((text) =>
      parseOr<OrientResult>(text, {
        headline: "Orient parse failure — situation unknown",
        sections: [],
        whatChanged: "Unknown — forebrain could not parse",
        emotionalState: emotionalWeight,
        metrics: {},
      }),
    ),
  )
}

// ── Conscious (decide) ───────────────────────────────────────
export function runConsciousDecide(
  config: CortexRunnerConfig,
  orient: OrientResult,
  currentPlanState: string,
  availableActions: string,
): Effect.Effect<DecideResult, ModelError, ModelClient> {
  const prompt = skills.decide.render({
    cadence: config.cadence,
    cadenceGuidance: getCadenceGuidance("decide", config.cadence),
    headline: orient.headline,
    whatChanged: orient.whatChanged,
    emotionalState: orient.emotionalState,
    sections: orient.sections.map((s) => `#### ${s.heading}\n${s.body}`).join("\n\n"),
    metrics: JSON.stringify(orient.metrics, null, 2),
    currentPlanState,
    availableSkills: availableActions,
  })
  return callTier(config, "conscious", prompt).pipe(
    Effect.map((text) =>
      parseOr<DecideResult>(text, { decision: "continue", reasoning: "parse failure — defaulting to continue" }),
    ),
  )
}

// ── Conscious (evaluate) ─────────────────────────────────────
export function runConsciousEvaluate(
  config: CortexRunnerConfig,
  input: EvaluateInput,
): Effect.Effect<EvaluateResult, ModelError, ModelClient> {
  const secondsBudgeted = input.ticksBudgeted * 30
  const secondsConsumed = input.ticksConsumed * 30
  const overrunWarning =
    input.ticksConsumed > input.ticksBudgeted
      ? `\n\n**OVERRUN:** consumed ${input.ticksConsumed} ticks against a ${input.ticksBudgeted}-tick budget`
      : ""
  const prompt = skills.evaluate.render({
    cadence: config.cadence,
    cadenceGuidance: getCadenceGuidance("evaluate", config.cadence),
    task: input.task,
    goal: input.goal,
    successCondition: input.successCondition,
    ticksBudgeted: String(input.ticksBudgeted),
    secondsBudgeted: String(secondsBudgeted),
    ticksConsumed: String(input.ticksConsumed),
    secondsConsumed: String(secondsConsumed),
    overrunWarning,
    executionReport: input.executionReport,
    stateDiff: input.stateDiff,
    conditionCheck: input.conditionCheck,
    emotionalState: input.emotionalState,
    remainingSteps: input.remainingSteps,
  })
  return callTier(config, "conscious", prompt).pipe(
    Effect.map((text) =>
      parseOr<EvaluateResult>(text, {
        judgment: "partially_succeeded",
        reasoning: "parse failure — cannot determine outcome",
        transition: { transition: "next_step" },
      }),
    ),
  )
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/vcarl/workspace/roci && npx vitest run packages/core/src/cortex/tiers.test.ts`
Expected: PASS (extractJson/parseOr + 3 tier tests).

- [ ] **Step 6: Commit**

```bash
cd /Users/vcarl/workspace/roci
git add packages/core/src/cortex/parse.ts packages/core/src/cortex/tiers.ts packages/core/src/cortex/tiers.test.ts
git commit -m "feat(cortex): tier functions (hindbrain/forebrain/conscious) over ModelClient"
```

---

### Task 2: Cortex state + pure ladder helpers

**Files:**
- Create: `packages/core/src/cortex/state.ts`
- Test: `packages/core/src/cortex/state.test.ts`

**Interfaces:**
- Consumes: `DecideResult`, `WaitState` from `../skills/types.js`; `PlanStep` from `../core/types.js`.
- Produces:
  - `interface CortexState { accumulatedEvents: string[]; emotionalWeight: string; currentPlan: DecideResult | null; currentStepIndex: number; waitState: WaitState | null; lastOrientTick: number }`
  - `function freshCortexState(): CortexState`
  - `function shouldForceOrient(state, tick, orientInterval): boolean` — true when `accumulatedEvents.length > 0 && tick - lastOrientTick >= orientInterval`
  - `function formatStepTask(step: PlanStep, headline: string): string` — the prompt handed to the cybernetic worker
  - `function formatExecutionReport(output: string): string` — wraps a worker's text output as an execution report for evaluate
  - `function planSteps(plan: DecideResult | null): readonly PlanStep[]` — the steps if the plan is a `"plan"` decision, else `[]`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/cortex/state.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import {
  freshCortexState,
  shouldForceOrient,
  formatStepTask,
  planSteps,
} from "./state.js"
import type { DecideResult } from "../skills/types.js"

describe("freshCortexState", () => {
  it("starts empty", () => {
    const s = freshCortexState()
    expect(s.accumulatedEvents).toEqual([])
    expect(s.currentPlan).toBeNull()
    expect(s.lastOrientTick).toBe(0)
  })
})

describe("shouldForceOrient", () => {
  const s = { ...freshCortexState(), accumulatedEvents: ["e"], lastOrientTick: 0 }
  it("forces orient once the interval elapses with pending events", () => {
    expect(shouldForceOrient(s, 5, 5)).toBe(true)
    expect(shouldForceOrient(s, 4, 5)).toBe(false)
  })
  it("never forces when no events accumulated", () => {
    expect(shouldForceOrient(freshCortexState(), 99, 5)).toBe(false)
  })
})

describe("formatStepTask", () => {
  it("includes goal and success condition", () => {
    const task = formatStepTask(
      { task: "review", goal: "review PR #12", tier: "smart", successCondition: "approved or changes requested", timeoutTicks: 4 },
      "PR #12 awaits review",
    )
    expect(task).toContain("review PR #12")
    expect(task).toContain("approved or changes requested")
  })
})

describe("planSteps", () => {
  it("returns steps for a plan decision and [] otherwise", () => {
    const plan: DecideResult = { decision: "plan", reasoning: "go", steps: [{ task: "t", goal: "g", tier: "fast", successCondition: "c", timeoutTicks: 2 }] }
    expect(planSteps(plan)).toHaveLength(1)
    expect(planSteps({ decision: "continue", reasoning: "x" })).toEqual([])
    expect(planSteps(null)).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/vcarl/workspace/roci && npx vitest run packages/core/src/cortex/state.test.ts`
Expected: FAIL — cannot find module `./state.js`.

- [ ] **Step 3: Write `state.ts`**

Create `packages/core/src/cortex/state.ts`:

```typescript
import type { DecideResult, WaitState } from "../skills/types.js"
import type { PlanStep } from "../core/types.js"

export interface CortexState {
  accumulatedEvents: string[]
  emotionalWeight: string
  currentPlan: DecideResult | null
  currentStepIndex: number
  waitState: WaitState | null
  lastOrientTick: number
}

export function freshCortexState(): CortexState {
  return {
    accumulatedEvents: [],
    emotionalWeight: "",
    currentPlan: null,
    currentStepIndex: 0,
    waitState: null,
    lastOrientTick: 0,
  }
}

/** Force an orient when events have piled up for `orientInterval` ticks without one. */
export function shouldForceOrient(state: CortexState, tick: number, orientInterval: number): boolean {
  return state.accumulatedEvents.length > 0 && tick - state.lastOrientTick >= orientInterval
}

/** The steps of a plan decision, or [] for any other decision. */
export function planSteps(plan: DecideResult | null): readonly PlanStep[] {
  return plan && plan.decision === "plan" ? plan.steps : []
}

/** The instructions handed to a cybernetic worker for one plan step. */
export function formatStepTask(step: PlanStep, headline: string): string {
  return [
    `# Task: ${step.task}`,
    `Context: ${headline}`,
    `## Goal\n${step.goal}`,
    `## Success condition\n${step.successCondition}`,
    `Do this work now. When finished, report concisely what you did and whether the success condition is met.`,
  ].join("\n\n")
}

/** Wrap a worker's text output as the execution report fed to evaluate. */
export function formatExecutionReport(output: string): string {
  const trimmed = output.trim()
  return trimmed.length > 0 ? trimmed : "Worker produced no output."
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/vcarl/workspace/roci && npx vitest run packages/core/src/cortex/state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/vcarl/workspace/roci
git add packages/core/src/cortex/state.ts packages/core/src/cortex/state.test.ts
git commit -m "feat(cortex): cortex state + pure ladder helpers"
```

---

### Task 3: `runCortex` — the escalation-ladder loop

**Files:**
- Create: `packages/core/src/cortex/loop.ts`
- Test: `packages/core/src/cortex/loop.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: tier functions (Task 1), state helpers (Task 2), `Cybernetics` (Plan 2), `ModelClient` (Plan 1), `CortexModelConfig`, and the domain Tags (`EventProcessorTag`, `SituationClassifierTag`, `InterruptRegistryTag`, `StateRendererTag`, `PromptBuilderTag`), `CharacterFs`, `CharacterLog`, `ModelConfig`/`resolveModel` from `../core/model-config.js`, `Alert` from `../core/types.js`.
- Produces:
  - `interface CortexLoopConfig { char; containerId; containerEnv?; addDirs?; events: Queue.Queue<unknown>; initialState: unknown; cadence?: Cadence; cortexModels?: CortexModelConfig; workerModels?: ModelConfig; orientInterval?: number; workerTimeoutMs?: number; tickIntervalMs?: number }`
  - `type CortexResult = {_tag:"Completed"; finalState:unknown} | {_tag:"Interrupted"; finalState:unknown; criticals: Alert[]}`
  - `function runCortex(config: CortexLoopConfig): Effect.Effect<CortexResult, ModelError, ...all the Tags above...>`

- [ ] **Step 1: Write the failing loop test**

This test drives one full escalation: an event arrives → hindbrain escalates → forebrain synthesizes → conscious plans one step → the loop delegates to a fake `Cybernetics` → conscious evaluates → terminates. It provides fake layers for every Tag. The fake `ModelClient` returns different canned JSON depending on which skill template is in the prompt (detected by a marker string the templates contain).

Create `packages/core/src/cortex/loop.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { Effect, Layer, Queue } from "effect"
import { runCortex } from "./loop.js"
import { ModelClient } from "../model/client.js"
import type { ModelHandle } from "../model/handles.js"
import { Cybernetics, CyberneticsTest } from "../cybernetics/delegate.js"
import { EventProcessorTag } from "../core/limbic/thalamus/event-processor.js"
import { SituationClassifierTag } from "../core/limbic/thalamus/situation-classifier.js"
import { InterruptRegistryTag } from "../core/limbic/amygdala/interrupt.js"
import { StateRendererTag } from "../core/state-renderer.js"
import { PromptBuilderTag } from "../core/prompt-builder.js"
import { CharacterFs } from "../services/CharacterFs.js"
import { CharacterLog } from "../logging/log-writer.js"

// ModelClient that branches on the tier (each skill template names its stage).
// observe.md mentions "observe"/"disposition"; orient → headline; decide → decision; evaluate → judgment.
const scriptedClient = Layer.succeed(
  ModelClient,
  ModelClient.of({
    complete: (_h: ModelHandle, messages) =>
      Effect.sync(() => {
        const p = messages.map((m) => m.content).join(" ").toLowerCase()
        if (p.includes("disposition")) return { text: '{"disposition":"escalate","emotionalWeight":"😰","reason":"x"}', raw: {} }
        if (p.includes("headline")) return { text: '{"headline":"act now","sections":[],"whatChanged":"x","emotionalState":"😰","metrics":{}}', raw: {} }
        if (p.includes("judgment")) return { text: '{"judgment":"succeeded","reasoning":"done","transition":{"transition":"terminate","summary":"all done"}}', raw: {} }
        // decide
        return { text: '{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do the thing","tier":"smart","successCondition":"thing done","timeoutTicks":1}]}', raw: {} }
      }),
  }),
)

// Minimal fakes for the domain Tags. <<FILL>>: match the exact interface shapes from the
// verbatim type report — each method returns trivial values over an opaque state object {}.
const fakeDomain = Layer.mergeAll(
  Layer.succeed(EventProcessorTag, EventProcessorTag.of({ processEvent: () => ({}) })),
  Layer.succeed(SituationClassifierTag, SituationClassifierTag.of({
    summarize: () => ({ situation: {} as never, headline: "h", sections: [], metrics: {} }),
  })),
  Layer.succeed(InterruptRegistryTag, InterruptRegistryTag.of({
    rules: [],
    evaluate: () => [],
    criticals: () => [],
    softAlerts: () => [],
  })),
  Layer.succeed(StateRendererTag, StateRendererTag.of({
    snapshot: () => ({}),
    richSnapshot: () => ({}),
    stateDiff: () => "",
    logStateBar: () => {},
  })),
  Layer.succeed(PromptBuilderTag, PromptBuilderTag.of({ systemPrompt: () => "you are an agent" } as never)),
)

// CharacterFs + CharacterLog fakes. <<FILL>>: provide no-op implementations matching their
// interfaces (readBackground/readValues/readDiary → Effect.succeed(""); log emit/raw → Effect.void).
const fakeIo = Layer.mergeAll(/* CharacterFsTest, CharacterLogTest */)

describe("runCortex", () => {
  it("escalates, delegates one step, evaluates, and completes", async () => {
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "combat" })
      let delegated = false
      const cyb = CyberneticsTest((c) => {
        delegated = true
        return { status: "completed", output: `did ${c.task.slice(0, 10)}`, durationMs: 10 }
      })
      const result = yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        cadence: "real-time",
        orientInterval: 1,
        tickIntervalMs: 1, // keep the test fast
      }).pipe(
        Effect.provide(Layer.mergeAll(scriptedClient, cyb, fakeDomain, fakeIo)),
      )
      return { result, delegated }
    })
    const { result, delegated } = await Effect.runPromise(program)
    expect(delegated).toBe(true)
    expect(result._tag).toBe("Completed")
  }, 20_000)

  it("returns Interrupted when a critical interrupt fires", async () => {
    // InterruptRegistry whose criticals() returns one alert.
    const criticalDomain = Layer.mergeAll(
      Layer.succeed(EventProcessorTag, EventProcessorTag.of({ processEvent: () => ({}) })),
      Layer.succeed(SituationClassifierTag, SituationClassifierTag.of({ summarize: () => ({ situation: {} as never, headline: "h", sections: [], metrics: {} }) })),
      Layer.succeed(InterruptRegistryTag, InterruptRegistryTag.of({
        rules: [], evaluate: () => [], softAlerts: () => [],
        criticals: () => [{ priority: "critical", message: "hull critical" }],
      })),
      Layer.succeed(StateRendererTag, StateRendererTag.of({ snapshot: () => ({}), richSnapshot: () => ({}), stateDiff: () => "", logStateBar: () => {} })),
      Layer.succeed(PromptBuilderTag, PromptBuilderTag.of({ systemPrompt: () => "x" } as never)),
    )
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      return yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1", events, initialState: {}, tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(scriptedClient, CyberneticsTest(() => ({ status: "completed", output: "", durationMs: 1 })), criticalDomain, fakeIo)))
    })
    const result = await Effect.runPromise(program)
    expect(result._tag).toBe("Interrupted")
    if (result._tag === "Interrupted") expect(result.criticals[0].message).toContain("hull")
  }, 20_000)
})
```

- [ ] **Step 2: Resolve the `<<FILL>>` fakes**

Before running, replace the two `<<FILL>>` markers with concrete no-op layers. `CharacterFs` needs at least `readBackground`/`readValues`/`readDiary` returning `Effect.succeed("")`; inspect `packages/core/src/services/CharacterFs.ts` for the full interface and stub every method. `CharacterLog` needs `emit`/`raw` (and any others) returning `Effect.void` — inspect `packages/core/src/logging/log-writer.ts`. Provide them via `Layer.succeed(CharacterFs, CharacterFs.of({...}))` and `Layer.succeed(CharacterLog, CharacterLog.of({...}))`. (These are the only interfaces this plan didn't capture verbatim; stub exactly their methods.)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /Users/vcarl/workspace/roci && npx vitest run packages/core/src/cortex/loop.test.ts`
Expected: FAIL — cannot find module `./loop.js`.

- [ ] **Step 4: Write `loop.ts`**

Create `packages/core/src/cortex/loop.ts`. This mirrors the structure of `channel-session.ts` (drain → classify → criticals → hindbrain → escalate → forebrain+decide → execute-step-via-delegation → evaluate → tick), but executes plan steps by forking a `Cybernetics.delegate` fiber and polling it, instead of pushing channel events.

```typescript
import { Effect, Queue, Option, Fiber } from "effect"
import type { CharacterConfig } from "../services/CharacterFs.js"
import { CharacterFs } from "../services/CharacterFs.js"
import { CharacterLog, logToConsole } from "../logging/log-writer.js"
import { EventProcessorTag } from "../core/limbic/thalamus/event-processor.js"
import { SituationClassifierTag } from "../core/limbic/thalamus/situation-classifier.js"
import { InterruptRegistryTag } from "../core/limbic/amygdala/interrupt.js"
import { StateRendererTag } from "../core/state-renderer.js"
import { PromptBuilderTag } from "../core/prompt-builder.js"
import { Cybernetics } from "../cybernetics/delegate.js"
import type { DelegationResult } from "../cybernetics/types.js"
import { ModelClient } from "../model/client.js"
import type { ModelError } from "../model/errors.js"
import { DEFAULT_CORTEX_MODELS, type CortexModelConfig } from "../model/handles.js"
import { DEFAULT_MODEL_CONFIG, type ModelConfig } from "../core/model-config.js"
import type { Cadence } from "../skills/cadence.js"
import type { Alert } from "../core/types.js"
import {
  runHindbrain, runForebrain, runConsciousDecide, runConsciousEvaluate,
  type CortexRunnerConfig,
} from "./tiers.js"
import {
  freshCortexState, shouldForceOrient, planSteps, formatStepTask, formatExecutionReport,
} from "./state.js"

export interface CortexLoopConfig {
  char: CharacterConfig
  containerId: string
  containerEnv?: Record<string, string>
  addDirs?: string[]
  events: Queue.Queue<unknown>
  initialState: unknown
  cadence?: Cadence
  cortexModels?: CortexModelConfig
  workerModels?: ModelConfig
  orientInterval?: number
  workerTimeoutMs?: number
  tickIntervalMs?: number
}

export type CortexResult =
  | { readonly _tag: "Completed"; readonly finalState: unknown }
  | { readonly _tag: "Interrupted"; readonly finalState: unknown; readonly criticals: Alert[] }

const DEFAULT_TICK_MS = 30_000
const DEFAULT_ORIENT_INTERVAL = 5
const DEFAULT_WORKER_TIMEOUT_MS = 60 * 60 * 1000

const AVAILABLE_ACTIONS =
  "Each plan step is delegated to a Claude Code worker that does real work (shell, git, gh, file edits, game CLI). Plan concrete steps; each step.task names the action and step.goal describes the outcome."

export const runCortex = (config: CortexLoopConfig) =>
  Effect.gen(function* () {
    const eventProcessor = yield* EventProcessorTag
    const classifier = yield* SituationClassifierTag
    const interrupts = yield* InterruptRegistryTag
    const renderer = yield* StateRendererTag
    const promptBuilder = yield* PromptBuilderTag
    const cybernetics = yield* Cybernetics
    const charFs = yield* CharacterFs

    const cadence: Cadence = config.cadence ?? "planned-action"
    const orientInterval = config.orientInterval ?? DEFAULT_ORIENT_INTERVAL
    const tickMs = config.tickIntervalMs ?? DEFAULT_TICK_MS
    const workerTimeoutMs = config.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS
    const workerModels = config.workerModels ?? DEFAULT_MODEL_CONFIG
    const runnerConfig: CortexRunnerConfig = {
      char: config.char,
      cadence,
      models: config.cortexModels ?? DEFAULT_CORTEX_MODELS,
    }

    let state = config.initialState
    let cortex = freshCortexState()
    let tick = 0
    let stepStartTick = 0
    let stepStartSnapshot = renderer.richSnapshot(state)
    // Fiber running the current delegation, or null.
    let delegationFiber: Fiber.RuntimeFiber<DelegationResult, never> | null = null

    while (true) {
      tick++

      // 1. Drain world events into state.
      const tickEvents: string[] = []
      let draining = true
      while (draining) {
        const maybe = yield* Queue.poll(config.events)
        if (Option.isNone(maybe)) {
          draining = false
        } else {
          const event = maybe.value
          yield* Effect.try(() => {
            const r = eventProcessor.processEvent(event as never, state as never)
            if (r.stateUpdate) state = r.stateUpdate(state as never)
            if (r.log) r.log()
          }).pipe(Effect.catchAll((e) => logToConsole(config.char.name, "error", `event error: ${e}`)))
          tickEvents.push(
            typeof event === "object" && event !== null
              ? `type: ${(event as Record<string, unknown>).type ?? "unknown"}\n${JSON.stringify(event)}`
              : String(event),
          )
        }
      }

      // 2. Classify + critical interrupts (the amygdala cuts the line).
      const summary = classifier.summarize(state as never)
      renderer.logStateBar(config.char.name, summary.metrics)
      const criticals = interrupts.criticals(state as never, summary.situation)
      if (criticals.length > 0) {
        yield* logToConsole(config.char.name, "orchestrator", `Critical: ${criticals.map((a) => a.message).join("; ")}`)
        if (delegationFiber) yield* Fiber.interrupt(delegationFiber)
        return { _tag: "Interrupted" as const, finalState: state, criticals }
      }

      // 3. If a delegation is in flight, check whether it finished.
      if (delegationFiber) {
        const done = yield* Fiber.poll(delegationFiber).pipe(Effect.map(Option.isSome))
        if (done) {
          const result = yield* Fiber.join(delegationFiber)
          delegationFiber = null
          // EVALUATE the step outcome.
          const after = renderer.richSnapshot(state)
          const stepIdx = cortex.currentStepIndex
          const steps = planSteps(cortex.currentPlan)
          const step = steps[stepIdx]
          if (step) {
            const evalResult = yield* runConsciousEvaluate(runnerConfig, {
              task: step.task,
              goal: step.goal,
              successCondition: step.successCondition,
              ticksBudgeted: step.timeoutTicks,
              ticksConsumed: tick - stepStartTick,
              executionReport: formatExecutionReport(result.output),
              stateDiff: renderer.stateDiff(stepStartSnapshot, after),
              conditionCheck: `worker status: ${result.status}`,
              emotionalState: cortex.emotionalWeight,
              remainingSteps: steps.slice(stepIdx + 1).map((s) => `${s.task}: ${s.goal}`).join("\n") || "None.",
            })
            yield* logToConsole(config.char.name, "cortex", `evaluate: ${evalResult.judgment} → ${evalResult.transition.transition}`)
            if (evalResult.diaryEntry) {
              const diary = yield* charFs.readDiary(config.char).pipe(Effect.catchAll(() => Effect.succeed("")))
              yield* charFs.writeDiary(config.char, diary ? `${diary}\n\n${evalResult.diaryEntry}` : evalResult.diaryEntry).pipe(
                Effect.catchAll((e) => logToConsole(config.char.name, "error", `diary write failed: ${e}`)),
              )
            }
            const t = evalResult.transition
            if (t.transition === "terminate") return { _tag: "Completed" as const, finalState: state }
            if (t.transition === "wait") { cortex.waitState = t.wait; cortex.currentPlan = null }
            else if (t.transition === "replan") { cortex.currentPlan = null; cortex.lastOrientTick = 0 }
            else {
              // next_step
              cortex.currentStepIndex++
              if (cortex.currentStepIndex >= steps.length) cortex.currentPlan = null
            }
          }
        }
        // While a delegation runs, fall through to keep triaging the world, then sleep.
      }

      // 4. HINDBRAIN triage (only when idle of a running plan and there are events).
      let escalate = tick === 1
      if (!delegationFiber && tickEvents.length > 0) {
        const observe = yield* runHindbrain(runnerConfig, tickEvents, cortex.waitState)
        yield* logToConsole(config.char.name, "cortex", `hindbrain: ${observe.disposition} ${observe.emotionalWeight}`)
        cortex.emotionalWeight = observe.emotionalWeight
        if (observe.disposition !== "discard") cortex.accumulatedEvents.push(...tickEvents)
        if (observe.disposition === "escalate") escalate = true
      }
      if (!delegationFiber && !escalate && shouldForceOrient(cortex, tick, orientInterval)) escalate = true

      // 5. FOREBRAIN + CONSCIOUS(decide) — only when no plan is executing.
      if (escalate && !delegationFiber && cortex.currentPlan === null) {
        const background = yield* charFs.readBackground(config.char).pipe(Effect.catchAll(() => Effect.succeed("")))
        const values = yield* charFs.readValues(config.char).pipe(Effect.catchAll(() => Effect.succeed("")))
        const diary = yield* charFs.readDiary(config.char).pipe(Effect.catchAll(() => Effect.succeed("")))
        const orient = yield* runForebrain(runnerConfig, cortex.accumulatedEvents, JSON.stringify(summary, null, 2), { background, values, diary }, cortex.emotionalWeight)
        yield* logToConsole(config.char.name, "cortex", `forebrain: ${orient.headline}`)
        const decide = yield* runConsciousDecide(runnerConfig, orient, "No active plan.", AVAILABLE_ACTIONS)
        yield* logToConsole(config.char.name, "cortex", `conscious: ${decide.decision}`)
        cortex.accumulatedEvents = []
        cortex.lastOrientTick = tick

        if (decide.decision === "terminate") return { _tag: "Completed" as const, finalState: state }
        if (decide.decision === "wait") {
          cortex.waitState = decide.wait
          if (decide.wait.disposition === "terminate") return { _tag: "Completed" as const, finalState: state }
        } else if (decide.decision === "plan" && decide.steps.length > 0) {
          cortex.currentPlan = decide
          cortex.currentStepIndex = 0
          // 6. Fork the first step as a cybernetic delegation.
          const step = decide.steps[0]
          const systemPrompt = (promptBuilder as { systemPrompt: (m: string, x: string) => string }).systemPrompt("select", "")
          stepStartTick = tick
          stepStartSnapshot = renderer.richSnapshot(state)
          yield* logToConsole(config.char.name, "orchestrator", `delegating: ${step.task}`)
          delegationFiber = yield* Effect.fork(
            cybernetics.delegate({
              containerId: config.containerId,
              playerName: config.char.name,
              char: config.char,
              task: formatStepTask(step, orient.headline),
              systemPrompt,
              model: workerModels.tiers[step.tier],
              timeoutMs: workerTimeoutMs,
              addDirs: config.addDirs,
              env: config.containerEnv,
            }),
          )
        }
      }

      // 7. Sleep one tick.
      yield* Effect.sleep(`${tickMs} millis`)
    }
  }) as Effect.Effect<
    CortexResult,
    ModelError,
    | EventProcessorTag | SituationClassifierTag | InterruptRegistryTag | StateRendererTag
    | PromptBuilderTag | CharacterFs | CharacterLog | ModelClient | Cybernetics
  >
```

- [ ] **Step 5: Run the loop test to verify it passes**

Run: `cd /Users/vcarl/workspace/roci && npx vitest run packages/core/src/cortex/loop.test.ts`
Expected: PASS (both tests). If `Fiber.poll`/`Fiber.join` types complain, confirm the `delegationFiber` type annotation matches `Effect.fork`'s return (`Fiber.RuntimeFiber<DelegationResult, never>`).

- [ ] **Step 6: Export from the index and typecheck**

Append to `packages/core/src/index.ts`:

```typescript
// Cortex — local-model escalation ladder
export { runCortex } from "./cortex/loop.js"
export type { CortexLoopConfig, CortexResult } from "./cortex/loop.js"
export { freshCortexState } from "./cortex/state.js"
export type { CortexState } from "./cortex/state.js"
export { runHindbrain, runForebrain, runConsciousDecide, runConsciousEvaluate } from "./cortex/tiers.js"
export type { CortexRunnerConfig } from "./cortex/tiers.js"
```

Run: `cd /Users/vcarl/workspace/roci && npx nx run @roci/core:build --skip-nx-cache`
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
cd /Users/vcarl/workspace/roci
git add packages/core/src/cortex/loop.ts packages/core/src/cortex/loop.test.ts packages/core/src/index.ts
git commit -m "feat(cortex): runCortex escalation-ladder loop delegating to Cybernetics"
```

---

## Self-Review

**Spec coverage (§4a, §4e, §5, §6):**
- ✅ §4a three tiers, identical shape, near-pure `(situation,state)→decision`, hold only tier name — Task 1 (`runHindbrain/runForebrain/runConsciousDecide/runConsciousEvaluate`, deps `ModelClient` only).
- ✅ §4e cortex state object — Task 2 (`CortexState`).
- ✅ §5 escalation-not-pipeline (hindbrain gate → forebrain → conscious), staleness timer (`shouldForceOrient`), amygdala cuts the line + aborts in-flight delegation (`Fiber.interrupt` on criticals), reflexes stay live during delegation (drain/triage continue while `delegationFiber` runs) — Task 3.
- ✅ §6 per-tier safe defaults on parse failure (hindbrain→accumulate, forebrain→raw, conscious-decide→continue, evaluate→next_step); model-unreachable propagates `ModelError` (fail fast) — Task 1.
- Deferred to Plan 4: wiring into domain phases and deleting `channel-session`/`ooda-runner`.

**Placeholder scan:** Two `<<FILL>>` markers in the Task 3 test (the `CharacterFs`/`CharacterLog` no-op layers), resolved in Task 3 Step 2 by inspecting those two interfaces — they are the only interfaces not captured verbatim during planning, so the stub is discovered, not guessed. No other placeholders.

**Type consistency:** `CortexRunnerConfig` is shared by all four tier functions and the loop. `runCortex`'s requirement union lists exactly the Tags `yield*`-ed in its body. `DelegationResult` (from Plan 2) is the fiber's success type. `planSteps`/`formatStepTask`/`formatExecutionReport`/`shouldForceOrient` signatures match their Task 2 definitions and Task 3 call sites. `workerModels.tiers[step.tier]` is valid: `step.tier` is `"fast"|"smart"`, both keys of `ModelConfig.tiers`. Skill-template render keys match `ooda-runner.ts` verbatim.
