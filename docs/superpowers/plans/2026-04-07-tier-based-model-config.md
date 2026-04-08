# Tier-Based Model Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make LLM model selection configurable. Replace ~10 hardcoded model strings (`"opus"`, `"sonnet"`, `"haiku"`) at `runTurn` call sites with a tier-based config (`fast` / `smart` / `reasoning`). Each role has a default tier; users can override per-role with either a tier name or a raw model string. Brain plan prompts reference tiers (not model names) so users can swap freely.

**Architecture:** A new `model-config.ts` core module defines `Tier`, `Role`, `ModelConfig`, `DEFAULT_MODEL_CONFIG`, and `resolveModel()`. `StateMachineConfig` and `CycleConfig` gain a `models: ModelConfig` field. `runOrchestrator` builds the config from defaults + `.roci/models.json` + CLI flags and threads it through. The brain plan output schema changes from `steps[].model: "haiku" | "sonnet"` to `steps[].tier: "fast" | "smart"`; the subagent manager looks up `config.models.tiers[step.tier]` directly.

**Tech Stack:** Effect, @effect/cli, @effect/platform, vitest, TypeScript

---

## File Structure

### New files
- `packages/core/src/core/model-config.ts` — `Tier`, `Role`, `ModelConfig`, `DEFAULT_MODEL_CONFIG`, `resolveModel()`, `isTier()`, `mergeModelConfig()`
- `packages/core/src/core/model-config.test.ts` — unit tests for `resolveModel` and `mergeModelConfig`

### Modified files
- `packages/core/src/core/types.ts` — change `PlanStep.model` to `PlanStep.tier`
- `packages/core/src/core/limbic/hypothalamus/types.ts` — add `models: ModelConfig` to `CycleConfig`
- `packages/core/src/core/orchestrator/state-machine.ts` — add `models: ModelConfig` to `StateMachineConfig`; pass into planning/eval/spawn services; replace hardcoded `"haiku"` in diary subagent with `resolveModel(... "diarySubagent", "fast")`
- `packages/core/src/core/orchestrator/planning/planning-cycle.ts` — add `models` to `PlanningServices`; thread into `brainPlan.execute`
- `packages/core/src/core/orchestrator/planning/brain.ts` — accept `model: AnyModel` from caller (resolved upstream); update `parsePlan` to read `tier` instead of `model`
- `packages/core/src/core/orchestrator/planning/subagent-manager.ts` — add `models` to spawn config + eval services; resolve subagent model via `config.models.tiers[finalStep.tier]`; resolve evaluate model via `resolveModel(..., "brainEvaluate", "reasoning")`
- `packages/core/src/core/limbic/hippocampus/dream.ts` — add `models` to `DreamInput`; resolve via `resolveModel(..., "dreamCompression", "smart")`
- `packages/core/src/core/limbic/hypothalamus/timeout-summarizer.ts` — accept `models` in turnContext; resolve via `resolveModel(..., "timeoutSummary", "fast")`
- `packages/domain-spacemolt/src/dinner.ts` — add `models` to `DinnerInput`; resolve via `resolveModel(..., "dinner", "smart")`
- `packages/core/src/core/character-scaffold.ts` — accept `models?: ModelConfig` opt; resolve identity/summary calls via `resolveModel(..., "scaffoldIdentity", "smart")` and `(..., "scaffoldSummary", "fast")`
- `packages/domain-spacemolt/src/prompts/plan.md` — replace `"haiku|sonnet"` schema hint with `"fast|smart"` and reword guidance
- `packages/domain-github/src/procedures/feature.md` — replace `"model": "sonnet"` example with `"tier": "smart"`
- `apps/roci/src/cli.ts` — add `--tier-fast`, `--tier-smart`, `--tier-reasoning` options; load `.roci/models.json`; pass through `runOrchestrator`
- `apps/roci/src/orchestrator.ts` — accept `models: ModelConfig`; thread into per-character phase data so phases can pass it into `runStateMachine`/`runPhases`

---

### Task 1: Create `model-config.ts` with tests (TDD)

**Files:**
- Create: `packages/core/src/core/model-config.ts`
- Create: `packages/core/src/core/model-config.test.ts`

- [ ] **Step 1: Write failing tests for `resolveModel` and `mergeModelConfig`**

Create `packages/core/src/core/model-config.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import {
  DEFAULT_MODEL_CONFIG,
  isTier,
  mergeModelConfig,
  resolveModel,
  type ModelConfig,
} from "./model-config.js"

describe("isTier", () => {
  it("returns true for known tier names", () => {
    expect(isTier("fast")).toBe(true)
    expect(isTier("smart")).toBe(true)
    expect(isTier("reasoning")).toBe(true)
  })

  it("returns false for raw model strings", () => {
    expect(isTier("opus")).toBe(false)
    expect(isTier("openrouter/anthropic/claude-sonnet-4")).toBe(false)
    expect(isTier("")).toBe(false)
  })
})

describe("resolveModel", () => {
  const base: ModelConfig = {
    tiers: { fast: "haiku", smart: "sonnet", reasoning: "opus" },
  }

  it("uses the default tier when no override exists", () => {
    expect(resolveModel(base, "brainPlan", "reasoning")).toBe("opus")
    expect(resolveModel(base, "timeoutSummary", "fast")).toBe("haiku")
    expect(resolveModel(base, "dreamCompression", "smart")).toBe("sonnet")
  })

  it("resolves a tier-name override to the configured tier model", () => {
    const config: ModelConfig = {
      ...base,
      roles: { dreamCompression: "fast" },
    }
    expect(resolveModel(config, "dreamCompression", "smart")).toBe("haiku")
  })

  it("returns a raw-model override verbatim", () => {
    const config: ModelConfig = {
      ...base,
      roles: { brainPlan: "openrouter/anthropic/claude-sonnet-4" },
    }
    expect(resolveModel(config, "brainPlan", "reasoning")).toBe(
      "openrouter/anthropic/claude-sonnet-4",
    )
  })

  it("falls back to the default tier when an override is undefined", () => {
    const config: ModelConfig = { ...base, roles: { dinner: undefined } }
    expect(resolveModel(config, "dinner", "smart")).toBe("sonnet")
  })

  it("respects custom tier values", () => {
    const config: ModelConfig = {
      tiers: { fast: "haiku", smart: "opus", reasoning: "opus" },
    }
    expect(resolveModel(config, "brainPlan", "smart")).toBe("opus")
  })
})

describe("mergeModelConfig", () => {
  it("returns defaults unchanged when no overlay supplied", () => {
    expect(mergeModelConfig(DEFAULT_MODEL_CONFIG, undefined)).toEqual(
      DEFAULT_MODEL_CONFIG,
    )
  })

  it("overlays tier values", () => {
    const merged = mergeModelConfig(DEFAULT_MODEL_CONFIG, {
      tiers: { smart: "opus" },
    })
    expect(merged.tiers).toEqual({
      fast: "haiku",
      smart: "opus",
      reasoning: "opus",
    })
  })

  it("overlays role overrides", () => {
    const merged = mergeModelConfig(DEFAULT_MODEL_CONFIG, {
      roles: { brainPlan: "fast", dinner: "openrouter/x" },
    })
    expect(merged.roles?.brainPlan).toBe("fast")
    expect(merged.roles?.dinner).toBe("openrouter/x")
  })

  it("merges roles additively without dropping existing keys", () => {
    const base: ModelConfig = {
      tiers: DEFAULT_MODEL_CONFIG.tiers,
      roles: { brainPlan: "smart" },
    }
    const merged = mergeModelConfig(base, { roles: { dinner: "fast" } })
    expect(merged.roles?.brainPlan).toBe("smart")
    expect(merged.roles?.dinner).toBe("fast")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/core/model-config.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `model-config.ts`**

Create `packages/core/src/core/model-config.ts`:

```typescript
import type { AnyModel } from "./limbic/hypothalamus/runtime.js"

/** The three tiers users can configure. */
export type Tier = "fast" | "smart" | "reasoning"

/**
 * Roles that resolve to a model. Each role has a default tier;
 * users may override per-role with a tier name or a raw model string.
 */
export type Role =
  | "brainPlan"
  | "brainInterrupt"
  | "brainEvaluate"
  | "diarySubagent"
  | "dreamCompression"
  | "dinner"
  | "timeoutSummary"
  | "scaffoldIdentity"
  | "scaffoldSummary"

export interface ModelConfig {
  tiers: Record<Tier, AnyModel>
  /** Per-role overrides. Each value is either a tier name or a raw model string. */
  roles?: Partial<Record<Role, Tier | AnyModel>>
}

/** Default config: fast=haiku, smart=sonnet, reasoning=opus, no role overrides. */
export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  tiers: {
    fast: "haiku",
    smart: "sonnet",
    reasoning: "opus",
  },
}

const TIER_NAMES = new Set<string>(["fast", "smart", "reasoning"])

export function isTier(value: string): value is Tier {
  return TIER_NAMES.has(value)
}

/**
 * Resolve a role to a concrete model string.
 * Order of precedence:
 *   1. Role override (tier name → tier value, OR raw model string passed through)
 *   2. The supplied default tier
 */
export function resolveModel(
  config: ModelConfig,
  role: Role,
  defaultTier: Tier,
): AnyModel {
  const override = config.roles?.[role]
  if (override !== undefined) {
    if (typeof override === "string" && isTier(override)) {
      return config.tiers[override]
    }
    return override
  }
  return config.tiers[defaultTier]
}

/**
 * Merge an overlay (e.g. user file or CLI flags) onto a base config.
 * Tier values are overlaid key-by-key. Roles are merged additively.
 */
export function mergeModelConfig(
  base: ModelConfig,
  overlay: Partial<ModelConfig> | undefined,
): ModelConfig {
  if (!overlay) return base
  return {
    tiers: { ...base.tiers, ...(overlay.tiers ?? {}) },
    roles: { ...(base.roles ?? {}), ...(overlay.roles ?? {}) },
  }
}
```

- [ ] **Step 4: Run tests until green**

Run: `pnpm vitest run packages/core/src/core/model-config.test.ts`
Expected: PASS — all eight test cases green

---

### Task 2: Update `Plan` type to use `tier` instead of `model`

**Files:**
- Modify: `packages/core/src/core/types.ts`

- [ ] **Step 1: Replace `model` with `tier` in `PlanStep`**

In `packages/core/src/core/types.ts`, replace the `PlanStep` interface:

```typescript
export interface PlanStep {
  task: string       // e.g. "mine", "travel", "sell", "dock", "refuel", "chat", "explore"
  goal: string       // NL goal for the subagent
  tier: "fast" | "smart"  // tier name; resolved to a concrete model at spawn time
  successCondition: string  // checked against game state
  timeoutTicks: number
}
```

- [ ] **Step 2: Verify TypeScript build surfaces all the call sites**

Run: `pnpm -F @roci/core typecheck`
Expected: errors at every old `step.model` reference (brain.ts, subagent-manager.ts, state-machine.ts diary step). These are addressed in later tasks.

---

### Task 3: Add `models: ModelConfig` to `CycleConfig` and `StateMachineConfig`

**Files:**
- Modify: `packages/core/src/core/limbic/hypothalamus/types.ts`
- Modify: `packages/core/src/core/orchestrator/state-machine.ts`

- [ ] **Step 1: Add `models` to `CycleConfig`**

In `packages/core/src/core/limbic/hypothalamus/types.ts`, add an import and a new field:

```typescript
import type { ModelConfig } from "../../model-config.js"
```

Inside `CycleConfig`, add (alongside the existing `brainModel`/`bodyModel` fields — keep those for now, the planned-action path still uses them):

```typescript
  /** Tier-based model config used by orchestrator-internal calls. */
  models: ModelConfig
```

- [ ] **Step 2: Add `models` to `StateMachineConfig`**

In `packages/core/src/core/orchestrator/state-machine.ts`, add the import:

```typescript
import type { ModelConfig } from "../model-config.js"
import { resolveModel } from "../model-config.js"
```

Add to `StateMachineConfig`:

```typescript
  /** Tier-based model config; threaded into planning, spawn, and evaluation services. */
  models: ModelConfig
```

- [ ] **Step 3: Thread `models` into `planningServices`, `evalServices`, and `spawnConfig`**

In `runStateMachine`, update the three service objects so each carries `models: config.models`:

```typescript
    const planningServices = { char: config.char, containerId: config.containerId, playerName: config.playerName, containerEnv: config.containerEnv, addDirs: config.addDirs, tickIntervalSec: config.tickIntervalSec, hooks, renderer, models: config.models }
    const evalServices = {
      renderer,
      classifier,
      skills,
      hooks,
      tickIntervalSec: config.tickIntervalSec,
      char: config.char,
      containerId: config.containerId,
      playerName: config.playerName,
      containerEnv: config.containerEnv,
      addDirs: config.addDirs,
      modeRef,
      investigationReportRef,
      models: config.models,
    }
    const spawnConfig = {
      char: config.char,
      containerId: config.containerId,
      playerName: config.playerName,
      containerEnv: config.containerEnv,
      addDirs: config.addDirs,
      tickIntervalSec: config.tickIntervalSec,
      modeRef,
      models: config.models,
    }
```

- [ ] **Step 4: Replace hardcoded diary subagent step**

Inside `maybeCompleteProcedure` in the same file, replace the `diaryStep` literal and `runTurn` call:

```typescript
        const diaryModel = resolveModel(config.models, "diarySubagent", "fast")
        const diaryStep = { task: "diary" as const, goal: diaryPrompt, tier: "fast" as const, successCondition: "diary updated", timeoutTicks: 3 }
        const diaryTurnPrompt = promptBuilder.subagentPrompt({
          step: diaryStep,
          state,
          situation: procedureSummary.situation,
          identity: {
            personality,
            values,
            tickIntervalSec: config.tickIntervalSec,
          },
          mode,
        })

        yield* runTurn({
          char: config.char,
          containerId: config.containerId,
          playerName: config.playerName,
          systemPrompt: systemPromptText,
          prompt: diaryTurnPrompt,
          model: diaryModel,
          timeoutMs: 60_000,
          env: config.containerEnv,
          addDirs: config.addDirs,
          role: "brain",
        }).pipe(
```

- [ ] **Step 5: Build to confirm wiring**

Run: `pnpm -F @roci/core typecheck`
Expected: state-machine.ts compiles; remaining errors are in planning/brain.ts and subagent-manager.ts (next tasks).

---

### Task 4: Update `brain.ts` to use `resolveModel` and parse `tier`

**Files:**
- Modify: `packages/core/src/core/orchestrator/planning/brain.ts`

- [ ] **Step 1: Update `parsePlan` to read `tier`**

Replace the `parsePlan` function:

```typescript
function parsePlan(output: string, validProcedures?: string[]): Plan {
  let json = output.trim()
  const fenceMatch = json.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (fenceMatch) {
    json = fenceMatch[1]
  }
  const parsed = JSON.parse(json)
  const plan: Plan = {
    reasoning: parsed.reasoning ?? "",
    steps: Array.isArray(parsed.steps)
      ? parsed.steps.map((s: Record<string, unknown>) => ({
          task: (s.task as string) ?? "explore",
          goal: (s.goal as string) ?? "",
          tier: (s.tier as "fast" | "smart") ?? "fast",
          successCondition: (s.successCondition as string) ?? "",
          timeoutTicks: (s.timeoutTicks as number) ?? 10,
        }))
      : [],
  }

  const procs = validProcedures ?? ["triage", "feature", "review"]
  if (parsed.procedure && procs.includes(parsed.procedure)) {
    plan.procedure = parsed.procedure
    plan.targets = Array.isArray(parsed.targets) ? parsed.targets : []
  }

  return plan
}
```

- [ ] **Step 2: Accept a `model: AnyModel` field on each brain function input**

Add an import:

```typescript
import type { AnyModel } from "../../limbic/hypothalamus/runtime.js"
```

Extend `BrainContainerContext`:

```typescript
export interface BrainContainerContext {
  containerId: string
  playerName: string
  char: CharacterConfig
  containerEnv?: Record<string, string>
  addDirs?: string[]
  /** Resolved model for this brain call (caller resolves via resolveModel + ModelConfig). */
  model: AnyModel
}
```

Update the three `runTurn` calls (`brainPlan`, `brainInterrupt`, `brainEvaluate`) to pass `model: input.model` instead of the literal `"opus"`:

```typescript
      const result = yield* runTurn({
        containerId: input.containerId,
        playerName: input.playerName,
        char: input.char,
        systemPrompt: "",
        prompt,
        model: input.model,
        timeoutMs: 180_000,
        env: input.containerEnv,
        addDirs: input.addDirs,
        role: "brain",
      })
```

(Apply this same change to all three functions; keep `brainEvaluate`'s `timeoutMs: 120_000`.)

- [ ] **Step 3: Build to confirm**

Run: `pnpm -F @roci/core typecheck`
Expected: errors now only in `planning-cycle.ts`, `subagent-manager.ts`, and `state-machine.ts` (the `brainInterrupt.execute` call site).

---

### Task 5: Pass resolved model into brain calls from planning-cycle and state-machine

**Files:**
- Modify: `packages/core/src/core/orchestrator/planning/planning-cycle.ts`
- Modify: `packages/core/src/core/orchestrator/state-machine.ts`

- [ ] **Step 1: Add `models` to `PlanningServices` and resolve for `brainPlan`**

In `planning-cycle.ts`, add imports and a field:

```typescript
import type { ModelConfig } from "../../model-config.js"
import { resolveModel } from "../../model-config.js"
```

```typescript
interface PlanningServices {
  readonly char: CharacterConfig
  readonly containerId: string
  readonly playerName: string
  readonly containerEnv?: Record<string, string>
  readonly addDirs?: string[]
  readonly tickIntervalSec: number
  readonly hooks?: LifecycleHooks
  readonly renderer?: StateRenderer
  readonly models: ModelConfig
}
```

In the `brainPlan.execute({...})` call, add the resolved model:

```typescript
      const newPlan = yield* brainPlan.execute({
        state,
        summary,
        diary,
        background,
        values,
        previousFailure: previousFailure ?? undefined,
        recentChat: recentChat.length > 0 ? recentChat : undefined,
        stepTimingHistory: stepTimingHistory.length > 0 ? stepTimingHistory : undefined,
        tickIntervalSec: services.tickIntervalSec,
        additionalContext,
        mode,
        investigationReport: investigationReport ?? undefined,
        procedureTargets: procedureTargets.length > 0 ? procedureTargets : undefined,
        containerId: services.containerId,
        playerName: services.playerName,
        char: services.char,
        containerEnv: services.containerEnv,
        addDirs: services.addDirs,
        model: resolveModel(services.models, "brainPlan", "reasoning"),
      })
```

- [ ] **Step 2: Resolve model for `brainInterrupt` in `state-machine.ts`**

Inside `handleInterrupt` in `state-machine.ts`, update the `brainInterrupt.execute(...)` call to include the resolved model:

```typescript
        const newPlan = yield* brainInterrupt.execute({
          state,
          summary,
          alerts: criticals,
          currentPlan: yield* Ref.get(planRef),
          background,
          mode,
          procedureTargets: procedureTargets.length > 0 ? procedureTargets : undefined,
          containerId: config.containerId,
          playerName: config.playerName,
          char: config.char,
          containerEnv: config.containerEnv,
          addDirs: config.addDirs,
          model: resolveModel(config.models, "brainInterrupt", "reasoning"),
        })
```

- [ ] **Step 3: Build**

Run: `pnpm -F @roci/core typecheck`
Expected: only `subagent-manager.ts` errors remain.

---

### Task 6: Update `subagent-manager.ts` to read `tier` and resolve models

**Files:**
- Modify: `packages/core/src/core/orchestrator/planning/subagent-manager.ts`

- [ ] **Step 1: Add imports**

```typescript
import type { ModelConfig } from "../../model-config.js"
import { resolveModel } from "../../model-config.js"
```

- [ ] **Step 2: Add `models` to `EvaluateServices` and `SpawnSubagentConfig`**

```typescript
interface EvaluateServices {
  readonly renderer: StateRenderer
  readonly classifier: SituationClassifier
  readonly skills: SkillRegistry
  readonly hooks?: LifecycleHooks
  readonly tickIntervalSec: number
  readonly char: CharacterConfig
  readonly containerId: string
  readonly playerName: string
  readonly containerEnv?: Record<string, string>
  readonly addDirs?: string[]
  readonly modeRef?: Ref.Ref<BrainMode>
  readonly investigationReportRef?: Ref.Ref<string | null>
  readonly models: ModelConfig
}
```

```typescript
interface SpawnSubagentConfig {
  readonly char: CharacterConfig
  readonly containerId: string
  readonly playerName: string
  readonly containerEnv?: Record<string, string>
  readonly addDirs?: string[]
  readonly tickIntervalSec: number
  readonly modeRef?: Ref.Ref<BrainMode>
  readonly models: ModelConfig
}
```

- [ ] **Step 3: Resolve `brainEvaluate` model**

Inside `evaluateCompletedSubagent`, update the `brainEvaluate.execute({...})` call to include:

```typescript
          model: resolveModel(services.models, "brainEvaluate", "reasoning"),
```

- [ ] **Step 4: Resolve subagent model from tier**

Inside `maybeSpawnSubagent`, replace the log + `runTurn` block with:

```typescript
      const subagentModel = smConfig.models.tiers[finalStep.tier]

      const fiber = yield* Effect.gen(function* () {
        yield* log.action(smConfig.char, {
          timestamp: new Date().toISOString(),
          source: "orchestrator",
          character: smConfig.char.name,
          type: "subagent_spawn",
          task: finalStep.task,
          goal: finalStep.goal,
          model: subagentModel,
        })

        const result = yield* runTurn({
          char: smConfig.char,
          containerId: smConfig.containerId,
          playerName: smConfig.playerName,
          systemPrompt,
          prompt,
          model: subagentModel,
          timeoutMs: finalStep.timeoutTicks * smConfig.tickIntervalSec * 1000,
          env: smConfig.containerEnv,
          addDirs: smConfig.addDirs,
          role: "brain",
        })
```

- [ ] **Step 5: Build**

Run: `pnpm -F @roci/core typecheck`
Expected: PASS for `@roci/core`. Remaining errors will be in domain packages (dream/dinner/timeout/scaffold) and the apps package.

---

### Task 7: Thread `ModelConfig` through dream, timeout-summarizer, dinner, and character-scaffold

**Files:**
- Modify: `packages/core/src/core/limbic/hippocampus/dream.ts`
- Modify: `packages/core/src/core/limbic/hypothalamus/timeout-summarizer.ts`
- Modify: `packages/domain-spacemolt/src/dinner.ts`
- Modify: `packages/core/src/core/character-scaffold.ts`

- [ ] **Step 1: `dream.ts` — accept `models` and resolve**

Add the import at the top of `packages/core/src/core/limbic/hippocampus/dream.ts`:

```typescript
import type { ModelConfig } from "../../model-config.js"
import { resolveModel } from "../../model-config.js"
```

Add to `DreamInput`:

```typescript
export interface DreamInput {
  char: CharacterConfig
  containerId: string
  playerName: string
  addDirs?: string[]
  env?: Record<string, string>
  models: ModelConfig
}
```

Inside `dream.execute`, resolve once and use the result for both calls:

```typescript
      const dreamModel = resolveModel(input.models, "dreamCompression", "smart")
```

Replace `model: "opus"` in both `runTurn` calls (diary compression and secrets compression) with `model: dreamModel`.

- [ ] **Step 2: `timeout-summarizer.ts` — accept `models`**

Update the function signature in `packages/core/src/core/limbic/hypothalamus/timeout-summarizer.ts`:

```typescript
import type { ModelConfig } from "../../model-config.js"
import { resolveModel } from "../../model-config.js"

export const summarizeTimeout = (
  partialOutput: string,
  role: "brain" | "body",
  turnContext: {
    containerId: string
    playerName: string
    char: CharacterConfig
    addDirs?: string[]
    env?: Record<string, string>
    models: ModelConfig
  },
): Effect.Effect<string, ClaudeError, CommandExecutor.CommandExecutor | CharacterLog | OAuthToken> =>
```

Replace the `model: "haiku"` literal:

```typescript
      model: resolveModel(turnContext.models, "timeoutSummary", "fast"),
```

Update any call site (search for `summarizeTimeout(`) to pass `models` from the surrounding `CycleConfig` / `TurnConfig`.

- [ ] **Step 3: `dinner.ts` — accept `models` and resolve**

In `packages/domain-spacemolt/src/dinner.ts`:

```typescript
import type { ModelConfig } from "@roci/core/core/model-config.js"
import { resolveModel } from "@roci/core/core/model-config.js"
```

```typescript
export interface DinnerInput {
  char: CharacterConfig
  containerId: string
  playerName: string
  addDirs?: string[]
  env?: Record<string, string>
  models: ModelConfig
}
```

Replace `model: "opus"` in the `runTurn` call:

```typescript
        model: resolveModel(input.models, "dinner", "smart"),
```

- [ ] **Step 4: `character-scaffold.ts` — accept optional `models`**

In `packages/core/src/core/character-scaffold.ts`, add imports:

```typescript
import { DEFAULT_MODEL_CONFIG, resolveModel, type ModelConfig } from "./model-config.js"
import type { ClaudeModel } from "../services/Claude.js"
```

Change `generateIdentityWithClaude` and `generateSummaryWithClaude` to accept a resolved model:

```typescript
function generateIdentityWithClaude(opts: {
  characterName: string
  characterDescription: string
  identityTemplate?: { backgroundHints: string; valuesHints: string }
  containerId: string
  model: ClaudeModel
}): { background: string; values: string } | null {
  // ...
  const output = execFileSync("docker", [
    "exec", "-i", opts.containerId,
    "claude", ...claudeBaseArgs(opts.model),
  ], { /* ...unchanged... */ })
```

```typescript
function generateSummaryWithClaude(
  characterName: string,
  background: string,
  containerId: string,
  model: ClaudeModel,
): string | null {
  // ...
  const output = execFileSync("docker", [
    "exec", "-i", containerId,
    "claude", ...claudeBaseArgs(model),
  ], { /* ...unchanged... */ })
```

Add `models?: ModelConfig` to `scaffoldCharacter`'s opts and resolve before each call:

```typescript
export const scaffoldCharacter = (opts: {
  projectRoot: string
  characterName: string
  identityTemplate?: { backgroundHints: string; valuesHints: string }
  characterDescription?: string
  containerId: string
  models?: ModelConfig
}): Effect.Effect<{ results: string[], summary?: string }, never, never> =>
  Effect.sync(() => {
    const { projectRoot, characterName, identityTemplate, characterDescription, containerId } = opts
    const models = opts.models ?? DEFAULT_MODEL_CONFIG
    const identityModel = resolveModel(models, "scaffoldIdentity", "smart") as ClaudeModel
    const summaryModel = resolveModel(models, "scaffoldSummary", "fast") as ClaudeModel
    // ... existing body, passing identityModel/summaryModel to the helpers ...
```

The cast to `ClaudeModel` is acceptable because scaffold runs `claude` directly via `execFileSync`; if a user supplies a non-Claude model here it will simply error at exec time. Document this with a short comment:

```typescript
    // Note: scaffold uses claude CLI directly. Non-Claude tier values
    // will be passed through and may fail at exec time.
```

- [ ] **Step 5: Update all call sites of `dream`, `dinner`, `summarizeTimeout`, `scaffoldCharacter`**

Search for callers and pass `models` through:

Run: `pnpm -F @roci/core typecheck && pnpm -F @roci/domain-spacemolt typecheck && pnpm -F @roci/domain-github typecheck`

Expected: errors point at every caller. For each, thread `models` from the nearest `CycleConfig` / `StateMachineConfig` / phase data. The `cli.ts` `scaffoldCharacter` call should receive `models: DEFAULT_MODEL_CONFIG` (or the user-loaded config; see Task 9).

---

### Task 8: Update brain plan prompt templates to reference tiers

**Files:**
- Modify: `packages/domain-spacemolt/src/prompts/plan.md`
- Modify: `packages/domain-github/src/procedures/feature.md`

- [ ] **Step 1: SpaceMolt plan template**

In `packages/domain-spacemolt/src/prompts/plan.md`, change the JSON schema example so the per-step field is `tier` and the value enum is `fast|smart`. Replace lines around 13 and 21–22:

```
      "tier": "fast|smart",
```

```
- Use "fast" for routine tasks (mining, traveling, selling, docking, refueling)
- Use "smart" for tasks requiring judgment (combat, social interaction, complex trading)
```

Search the file for any other `haiku`/`sonnet`/`model` references and replace them likewise. Verify with:

Run: `grep -nE 'haiku|sonnet|"model"' packages/domain-spacemolt/src/prompts/plan.md`
Expected: no matches.

- [ ] **Step 2: GitHub feature procedure template**

In `packages/domain-github/src/procedures/feature.md`, replace the `"model": "sonnet"` line at ~line 39 with `"tier": "smart"`. Verify:

Run: `grep -nE 'haiku|sonnet|"model"' packages/domain-github/src/procedures/*.md packages/domain-github/src/prompts/*.md`
Expected: no matches.

---

### Task 9: CLI / orchestrator wiring (config file + flags)

**Files:**
- Modify: `apps/roci/src/cli.ts`
- Modify: `apps/roci/src/orchestrator.ts`

- [ ] **Step 1: Loader + flag parsing helper in `cli.ts`**

Add imports:

```typescript
import {
  DEFAULT_MODEL_CONFIG,
  mergeModelConfig,
  type ModelConfig,
  type Tier,
} from "@roci/core/core/model-config.js"
import type { AnyModel } from "@roci/core/core/limbic/hypothalamus/runtime.js"
```

Add a helper at the top of the file (after `PROJECT_ROOT`):

```typescript
/**
 * Load .roci/models.json if present and merge with defaults + CLI overrides.
 * CLI overrides take precedence over the file; the file takes precedence over defaults.
 */
function loadModelConfig(opts: {
  tierFast: Option.Option<string>
  tierSmart: Option.Option<string>
  tierReasoning: Option.Option<string>
}): ModelConfig {
  let merged: ModelConfig = DEFAULT_MODEL_CONFIG

  const filePath = path.resolve(PROJECT_ROOT, ".roci", "models.json")
  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, "utf-8")
      const parsed = JSON.parse(raw) as Partial<ModelConfig>
      merged = mergeModelConfig(merged, parsed)
    } catch (e) {
      // Non-fatal: log and continue with defaults
      console.error(`[roci] failed to parse .roci/models.json: ${e}`)
    }
  }

  const cliTiers: Partial<Record<Tier, AnyModel>> = {}
  if (Option.isSome(opts.tierFast)) cliTiers.fast = opts.tierFast.value
  if (Option.isSome(opts.tierSmart)) cliTiers.smart = opts.tierSmart.value
  if (Option.isSome(opts.tierReasoning)) cliTiers.reasoning = opts.tierReasoning.value
  if (Object.keys(cliTiers).length > 0) {
    merged = mergeModelConfig(merged, { tiers: cliTiers as Record<Tier, AnyModel> })
  }

  return merged
}
```

- [ ] **Step 2: Add the three CLI options**

Near the existing shared options:

```typescript
const tierFast = Options.text("tier-fast").pipe(Options.optional)
const tierSmart = Options.text("tier-smart").pipe(Options.optional)
const tierReasoning = Options.text("tier-reasoning").pipe(Options.optional)
```

Wire them into both `startCommand` and the default `rociCommand` option groups, e.g.:

```typescript
const startCommand = Command.make("start", {
  characters: startCharacters,
  tickInterval,
  domain: domainOption,
  manualApproval,
  tierFast,
  tierSmart,
  tierReasoning,
}, (args) =>
  Effect.gen(function* () {
    const models = loadModelConfig({
      tierFast: args.tierFast,
      tierSmart: args.tierSmart,
      tierReasoning: args.tierReasoning,
    })
    // ...existing body...
    yield* runOrchestrator(
      resolved,
      args.tickInterval,
      Option.getOrElse(args.manualApproval, () => false),
      models,
    )
  }),
).pipe(Command.withDescription("Start character(s) running"))
```

Mirror the same additions in `defaultCharacters`/`runAutoDetect`, threading `models` into `validateAndStart` and `runOrchestrator`. Update `validateAndStart`'s signature to take and forward `models: ModelConfig` (one-line passthrough).

- [ ] **Step 3: Pass `models` from `scaffoldCharacter` calls in setup paths**

In `setupCommand` (already builds `models` is unnecessary — setup uses defaults), pass `models: DEFAULT_MODEL_CONFIG` to keep behaviour consistent:

```typescript
      const { summary } = yield* scaffoldCharacter({
        projectRoot: PROJECT_ROOT,
        characterName: charName,
        identityTemplate: domainConfig.identityTemplate,
        containerId: "",
        models: DEFAULT_MODEL_CONFIG,
      })
```

- [ ] **Step 4: `runOrchestrator` accepts and threads `models`**

In `apps/roci/src/orchestrator.ts`:

```typescript
import type { ModelConfig } from "@roci/core/core/model-config.js"
```

```typescript
export const runOrchestrator = (
  resolvedDomains: ResolvedDomain[],
  tickIntervalSeconds: number,
  manualApproval = false,
  models: ModelConfig,
) =>
```

Inside the per-character `runPhases` call, include `models` in `phaseData` so phases can attach it to their `StateMachineConfig` / `CycleConfig`:

```typescript
            yield* runPhases(
              {
                char,
                containerId,
                containerEnv,
                containerAddDirs: rd.config.containerAddDirs,
                domainBundle: rd.config.bundle,
                phaseData: {
                  ...(manualApproval ? { manualApproval: true } : {}),
                  models,
                },
              },
              rd.config.phaseRegistry,
            )
```

- [ ] **Step 5: Update phase implementations that build `StateMachineConfig`/`CycleConfig`**

Search for constructors of `StateMachineConfig` and `CycleConfig` in domain packages:

Run: `grep -rn "runStateMachine(" packages/domain-spacemolt/src packages/domain-github/src apps/roci/src`
Run: `grep -rn "runCycle\b\|CycleConfig\b" packages/domain-spacemolt/src packages/domain-github/src`

For each, read `models` from `phaseData` and include it in the config object:

```typescript
const models = phaseData.models as ModelConfig
yield* runStateMachine({
  // ...existing fields...
  models,
})
```

The same applies to dream/dinner/scaffold phases — they read `models` from `phaseData` and pass it to the corresponding `*Input` objects.

- [ ] **Step 6: Whole-repo build**

Run: `pnpm build`
Expected: PASS

Run: `pnpm test`
Expected: PASS, including the new `model-config.test.ts` cases.

---

### Task 10: Manual smoke verification

- [ ] **Step 1: Default config — no file, no flags**

Run: `pnpm tsx apps/roci/src/main.ts start --domain spacemolt <character>` (or any equivalent default flow available locally)
Expected: behaviour unchanged from before the refactor — brain still uses opus, dinner still uses sonnet (smart tier), subagents still use the tiers their plan steps select.

- [ ] **Step 2: File-based override**

Create `.roci/models.json`:

```json
{
  "tiers": { "smart": "opus" },
  "roles": { "dreamCompression": "fast", "brainPlan": "smart" }
}
```

Re-run a character. Confirm via logs that brain plan calls now use `opus` (smart, since smart=opus), dream compression uses `haiku`, and other roles fall back to the defaults.

- [ ] **Step 3: CLI flag override**

Run: `... start --tier-fast haiku --tier-smart sonnet --tier-reasoning opus <character>`
Expected: same as defaults; flags override the file values when both are present.

- [ ] **Step 4: Mark plan complete**

Run: full test + build one more time:

```
pnpm build && pnpm test
```

Expected: green.

---

## Self-review checklist

- [x] `model-config.ts` exports match the spec exactly (`Tier`, `Role`, `ModelConfig`, `DEFAULT_MODEL_CONFIG`, `isTier`, `resolveModel`, plus `mergeModelConfig` for the CLI loader).
- [x] `Plan.steps[].model` removed; `Plan.steps[].tier: "fast" | "smart"` added.
- [x] Every previously hardcoded model literal is covered: `brain.ts` x3 (resolved upstream), `subagent-manager.ts` (tier lookup + brainEvaluate), `state-machine.ts` diary subagent, `dream.ts` x2, `timeout-summarizer.ts`, `dinner.ts`, `character-scaffold.ts` x2.
- [x] Default role-to-tier mappings as specified: brainPlan/Interrupt/Evaluate=reasoning, dreamCompression=smart, dinner=smart, timeoutSummary=fast, diarySubagent=fast, scaffoldIdentity=smart, scaffoldSummary=fast.
- [x] Subagent manager uses `config.models.tiers[finalStep.tier]` directly (not `resolveModel`), per spec.
- [x] CLI loads `.roci/models.json`, merges with defaults, and applies `--tier-*` flag overrides on top. No per-role CLI flags (file-only), per spec.
- [x] Brain prompt templates updated: `packages/domain-spacemolt/src/prompts/plan.md` and `packages/domain-github/src/procedures/feature.md`.
- [x] `ModelConfig` is threaded through `StateMachineConfig`, `CycleConfig`, `PlanningServices`, `EvaluateServices`, `SpawnSubagentConfig`, and via `phaseData` from `runOrchestrator`.
- [x] TDD applied where it pays off (the pure `model-config.ts` module).
- [x] No placeholders; every code block is a complete, drop-in replacement or addition.
