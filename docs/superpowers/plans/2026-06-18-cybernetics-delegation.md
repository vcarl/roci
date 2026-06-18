# Cybernetics Delegation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `cybernetics/` module — a `Cybernetics` Effect service whose `delegate(config)` spawns `claude -p` in the Docker container to run ONE scoped task to completion and returns a structured `DelegationResult`.

**Architecture:** `delegate` is a thin wrapper over the existing `runTurn` (`process-runner.ts`), which already does container exec, OAuth injection, stream-json parsing, and timeout. The wrapper runs with tools enabled (`role: "body"`, `noTools: false`), maps `TurnResult` → `DelegationResult`, and **catches `ClaudeError` into a `{status: "failed"}` result** so the caller (the cortex's conscious tier) evaluates failure like any other outcome rather than crashing.

**Tech Stack:** TypeScript (ESM, strict), Effect (`Context.Tag` / `Layer`), vitest. Package: `@roci/core`.

**Scope note:** Plan 2 of 4 from `docs/superpowers/specs/2026-06-18-cortex-cybernetics-design.md`. Additive: creates `packages/core/src/cybernetics/`, reuses `runTurn`, deletes nothing. Plan 3 (cortex) consumes the `Cybernetics` tag; Plan 4 wires the Live layer into the domains and removes the old engine.

## Global Constraints

- ESM with explicit `.js` import extensions on relative imports.
- vitest, colocated `*.test.ts`.
- Errors are plain `_tag` classes (match `ClaudeError`); Effect typed error channel, not `throw`.
- No new runtime dependencies.
- Pre-commit runs `nx run-many -t build` (tsc) — every commit typechecks clean.
- `runTurn` signature (verbatim, from `process-runner.ts`): `runTurn(config: TurnConfig): Effect.Effect<TurnResult, ClaudeError, CommandExecutor.CommandExecutor | CharacterLog | OAuthToken>`.
- `TurnResult` (verbatim): `{ output: string; timedOut: boolean; durationMs: number }`.
- `CharacterConfig` (verbatim): `{ name: string; dir: string }`.
- `AnyModel` is imported from `core/limbic/hypothalamus/runtime.js`.

---

### Task 1: Cybernetics types + pure result mapping

**Files:**
- Create: `packages/core/src/cybernetics/types.ts`
- Create: `packages/core/src/cybernetics/result.ts`
- Test: `packages/core/src/cybernetics/result.test.ts`

**Interfaces:**
- Consumes: `AnyModel` from `../core/limbic/hypothalamus/runtime.js`; `CharacterConfig` from `../services/CharacterFs.js`; `TurnResult` from `../core/limbic/hypothalamus/types.js`.
- Produces:
  - `interface DelegationConfig { containerId; playerName; char; task; systemPrompt; model; timeoutMs; addDirs?; env?; allowedTools? }`
  - `interface DelegationResult { status: "completed" | "timed_out"; output: string; durationMs: number }`
  - `function toDelegationResult(turn: TurnResult): DelegationResult`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/cybernetics/result.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { toDelegationResult } from "./result.js"

describe("toDelegationResult", () => {
  it("maps a normal completion", () => {
    expect(toDelegationResult({ output: "done", timedOut: false, durationMs: 1200 })).toEqual({
      status: "completed",
      output: "done",
      durationMs: 1200,
    })
  })

  it("maps a timed-out turn to status timed_out", () => {
    const r = toDelegationResult({ output: "partial", timedOut: true, durationMs: 9000 })
    expect(r.status).toBe("timed_out")
    expect(r.output).toBe("partial")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/vcarl/workspace/roci && npx vitest run packages/core/src/cybernetics/result.test.ts`
Expected: FAIL — cannot find module `./result.js`.

- [ ] **Step 3: Write the types and the mapping**

Create `packages/core/src/cybernetics/types.ts`:

```typescript
import type { AnyModel } from "../core/limbic/hypothalamus/runtime.js"
import type { CharacterConfig } from "../services/CharacterFs.js"

/** A single scoped unit of work handed to a cybernetic (Claude Code) worker. */
export interface DelegationConfig {
  containerId: string
  playerName: string
  char: CharacterConfig
  /** The scoped task instructions (becomes the worker's stdin prompt). */
  task: string
  /** Identity/capability context for the worker (becomes --system-prompt). */
  systemPrompt: string
  /** Model the worker runs on (e.g. "sonnet"). */
  model: AnyModel
  /** Wall-clock budget before the worker is interrupted. */
  timeoutMs: number
  addDirs?: string[]
  env?: Record<string, string>
  /** If set, restrict the worker's tools via --allowedTools. */
  allowedTools?: string[]
}

/**
 * Outcome of a delegation. `failed` is produced when the underlying claude
 * invocation errors (e.g. auth) — captured, not thrown, so the conscious tier
 * can evaluate it like any other result.
 */
export interface DelegationResult {
  status: "completed" | "timed_out" | "failed"
  /** The worker's final text output, or the error message when failed. */
  output: string
  durationMs: number
}
```

Create `packages/core/src/cybernetics/result.ts`:

```typescript
import type { TurnResult } from "../core/limbic/hypothalamus/types.js"
import type { DelegationResult } from "./types.js"

/** Map a completed (or timed-out) turn to a delegation result. */
export function toDelegationResult(turn: TurnResult): DelegationResult {
  return {
    status: turn.timedOut ? "timed_out" : "completed",
    output: turn.output,
    durationMs: turn.durationMs,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/vcarl/workspace/roci && npx vitest run packages/core/src/cybernetics/result.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/vcarl/workspace/roci
git add packages/core/src/cybernetics/types.ts packages/core/src/cybernetics/result.ts packages/core/src/cybernetics/result.test.ts
git commit -m "feat(cybernetics): delegation types + TurnResult mapping"
```

---

### Task 2: Cybernetics service (Tag + Live layer over runTurn)

**Files:**
- Create: `packages/core/src/cybernetics/delegate.ts`
- Test: `packages/core/src/cybernetics/delegate.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `DelegationConfig`, `DelegationResult`, `toDelegationResult` (Task 1); `runTurn` from `../core/limbic/hypothalamus/process-runner.js`; `ClaudeError` from `../services/Claude.js`.
- Produces:
  - `class Cybernetics` (Effect `Context.Tag`) with `delegate(config: DelegationConfig): Effect.Effect<DelegationResult, never, CommandExecutor.CommandExecutor | CharacterLog | OAuthToken>`
  - `const CyberneticsLive: Layer.Layer<Cybernetics>`
  - `const CyberneticsTest: (impl: (c: DelegationConfig) => DelegationResult) => Layer.Layer<Cybernetics>` — a test helper that returns canned results without Docker.

- [ ] **Step 1: Write the failing test (using the test layer)**

The Live layer requires Docker, so the unit test exercises the **service contract** via `CyberneticsTest` (a fake that returns canned results) — this is the "fake exec returning canned results" the spec calls for, at the service boundary.

Create `packages/core/src/cybernetics/delegate.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import { Cybernetics, CyberneticsTest } from "./delegate.js"
import type { DelegationConfig } from "./types.js"

const cfg: DelegationConfig = {
  containerId: "c1",
  playerName: "ada",
  char: { name: "ada", dir: "/work/players/ada/me" },
  task: "fix the failing test",
  systemPrompt: "you are an engineer",
  model: "sonnet",
  timeoutMs: 1000,
}

describe("Cybernetics service contract", () => {
  it("delegate returns the canned result from the provided implementation", async () => {
    const layer = CyberneticsTest((c) => ({
      status: "completed",
      output: `did: ${c.task}`,
      durationMs: 42,
    }))
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const cyb = yield* Cybernetics
          return yield* cyb.delegate(cfg)
        }),
        layer,
      ),
    )
    expect(result).toEqual({ status: "completed", output: "did: fix the failing test", durationMs: 42 })
  })

  it("delegate can report a failed status", async () => {
    const layer = CyberneticsTest(() => ({ status: "failed", output: "auth error", durationMs: 5 }))
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const cyb = yield* Cybernetics
          return yield* cyb.delegate(cfg)
        }),
        layer,
      ),
    )
    expect(result.status).toBe("failed")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/vcarl/workspace/roci && npx vitest run packages/core/src/cybernetics/delegate.test.ts`
Expected: FAIL — cannot find module `./delegate.js`.

- [ ] **Step 3: Write the service, Live layer, and test layer**

Create `packages/core/src/cybernetics/delegate.ts`:

```typescript
import { Context, Effect, Layer } from "effect"
import { CommandExecutor } from "@effect/platform"
import { runTurn } from "../core/limbic/hypothalamus/process-runner.js"
import { ClaudeError } from "../services/Claude.js"
import { OAuthToken } from "../services/OAuthToken.js"
import { CharacterLog } from "../logging/log-writer.js"
import type { DelegationConfig, DelegationResult } from "./types.js"
import { toDelegationResult } from "./result.js"

export class Cybernetics extends Context.Tag("Cybernetics")<
  Cybernetics,
  {
    readonly delegate: (
      config: DelegationConfig,
    ) => Effect.Effect<
      DelegationResult,
      never,
      CommandExecutor.CommandExecutor | CharacterLog | OAuthToken
    >
  }
>() {}

const delegate = (
  config: DelegationConfig,
): Effect.Effect<DelegationResult, never, CommandExecutor.CommandExecutor | CharacterLog | OAuthToken> =>
  runTurn({
    containerId: config.containerId,
    playerName: config.playerName,
    char: config.char,
    prompt: config.task,
    systemPrompt: config.systemPrompt,
    model: config.model,
    timeoutMs: config.timeoutMs,
    role: "body",
    noTools: false,
    allowedTools: config.allowedTools,
    addDirs: config.addDirs,
    env: config.env,
  }).pipe(
    Effect.map(toDelegationResult),
    // A failed claude invocation (e.g. auth) is captured, not thrown.
    Effect.catchAll((e: ClaudeError) =>
      Effect.succeed<DelegationResult>({ status: "failed", output: e.message, durationMs: 0 }),
    ),
  )

/** Production layer — spawns claude -p in the container via runTurn. */
export const CyberneticsLive = Layer.succeed(Cybernetics, Cybernetics.of({ delegate }))

/** Test layer — returns canned results without touching Docker. */
export const CyberneticsTest = (
  impl: (config: DelegationConfig) => DelegationResult,
): Layer.Layer<Cybernetics> =>
  Layer.succeed(Cybernetics, Cybernetics.of({ delegate: (config) => Effect.succeed(impl(config)) }))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/vcarl/workspace/roci && npx vitest run packages/core/src/cybernetics/delegate.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Export from the package index**

Append to `packages/core/src/index.ts` (no-semicolon block style, matching the bottom of the file):

```typescript
// Cybernetics — frontier-model worker delegation
export type { DelegationConfig, DelegationResult } from "./cybernetics/types.js"
export { toDelegationResult } from "./cybernetics/result.js"
export { Cybernetics, CyberneticsLive, CyberneticsTest } from "./cybernetics/delegate.js"
```

- [ ] **Step 6: Typecheck**

Run: `cd /Users/vcarl/workspace/roci && npx nx run @roci/core:build --skip-nx-cache`
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
cd /Users/vcarl/workspace/roci
git add packages/core/src/cybernetics/delegate.ts packages/core/src/cybernetics/delegate.test.ts packages/core/src/index.ts
git commit -m "feat(cybernetics): Cybernetics service over runTurn + test layer"
```

---

### Task 3: Guarded real-container smoke test

**Files:**
- Create: `packages/core/src/cybernetics/delegate.smoke.test.ts`

Verifies `delegate` against a real running container, skipped unless `ROCI_CYBERNETICS_CONTAINER` is set. This is the only test that touches Docker + a live OAuth token.

**Interfaces:**
- Consumes: `Cybernetics`, `CyberneticsLive` (Task 2); plus the layers `runTurn` needs (`CommandExecutor`, `CharacterLog`, `OAuthToken`).

- [ ] **Step 1: Inspect how existing integration code provides runTurn's layers**

Read `apps/roci/src/cli.ts` and `packages/core/src/logging/log-writer.ts` to find the concrete `CharacterLog` layer name and how `CommandExecutor`/`OAuthToken` layers are assembled (search: `grep -rn "CharacterLogLive\|NodeCommandExecutor\|OAuthTokenLive" packages apps --include=*.ts`). Use the exact layer constructors found there in Step 2.

- [ ] **Step 2: Write the guarded smoke test**

Create `packages/core/src/cybernetics/delegate.smoke.test.ts`. Replace `<<LAYER ASSEMBLY>>` with the concrete layers identified in Step 1 (the same combination `cli.ts` provides to `runTurn`/`dream`):

```typescript
import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { Cybernetics, CyberneticsLive } from "./delegate.js"
import type { DelegationConfig } from "./types.js"

// ROCI_CYBERNETICS_CONTAINER=<containerId> npx vitest run packages/core/src/cybernetics/delegate.smoke.test.ts
const containerId = process.env.ROCI_CYBERNETICS_CONTAINER
const playerName = process.env.ROCI_CYBERNETICS_PLAYER ?? "test-pilot"

describe.skipIf(!containerId)("Cybernetics.delegate against a real container", () => {
  it("runs a trivial task to completion", async () => {
    const cfg: DelegationConfig = {
      containerId: containerId as string,
      playerName,
      char: { name: playerName, dir: `/work/players/${playerName}/me` },
      task: "Print the single word: pong. Do nothing else.",
      systemPrompt: "You are a terse assistant.",
      model: "sonnet",
      timeoutMs: 120_000,
    }
    // <<LAYER ASSEMBLY>>: const deps = Layer.mergeAll(NodeCommandExecutor.layer, CharacterLogLive, OAuthTokenLive, ...)
    const program = Effect.gen(function* () {
      const cyb = yield* Cybernetics
      return yield* cyb.delegate(cfg)
    })
    const result = await Effect.runPromise(
      Effect.provide(program, Layer.merge(CyberneticsLive, deps)),
    )
    expect(["completed", "timed_out"]).toContain(result.status)
  }, 130_000)
})
```

- [ ] **Step 3: Verify it skips cleanly**

Run: `cd /Users/vcarl/workspace/roci && npx vitest run packages/core/src/cybernetics/delegate.smoke.test.ts`
Expected: suite skipped (0 failures).

- [ ] **Step 4: Commit**

```bash
cd /Users/vcarl/workspace/roci
git add packages/core/src/cybernetics/delegate.smoke.test.ts
git commit -m "test(cybernetics): guarded real-container delegate smoke"
```

---

## Self-Review

**Spec coverage (§4c, §6, §7):**
- ✅ §4c `delegate(task) → result` spawning `claude -p` run-to-completion, the only thing crossing into Docker, reusing container/OAuth/exec plumbing — Task 2 (`CyberneticsLive` over `runTurn`).
- ✅ §6 delegation failure/timeout captured as a structured result (`status: failed | timed_out`) — Task 1 mapping + Task 2 `catchAll`.
- ✅ §7 cybernetics tested against a fake exec returning canned results (`CyberneticsTest`) + one real smoke — Tasks 2 & 3.

**Placeholder scan:** One intentional `<<LAYER ASSEMBLY>>` in Task 3 Step 2, resolved by the Step 1 investigation (the exact host-layer combination is environment-specific and discovered, not guessed). All other steps are complete.

**Type consistency:** `DelegationConfig`/`DelegationResult` fields are identical across `types.ts`, `result.ts`, `delegate.ts`, and all tests. `Cybernetics.delegate` returns `Effect<DelegationResult, never, CommandExecutor | CharacterLog | OAuthToken>` consistently; `CyberneticsTest` produces the same tag with a no-requirement `Effect.succeed`. `model: "sonnet"` is a valid `AnyModel`.
