# Domain Integration & Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch both domains' active phase from `runChannelSession` to `runCortex`, provide the new `ModelClientLive` + `CyberneticsLive` layers at the app level, and delete the now-dead channel/OODA engine.

**Architecture:** Each domain's active phase already calls an engine with `(char, containerId, containerEnv, addDirs, events, initialState, cadence, …)` and branches on `result._tag === "Interrupted"`. `runCortex` (Plan 3) has the same call shape and result contract, so the rewire is a near-mechanical swap. The cortex's extra runtime requirements (`ModelClient`, `Cybernetics`) are satisfied by a top-level layer added once in the app, alongside the existing `CharacterFs`/`CharacterLog`/`CommandExecutor`/`OAuthToken` layers. After both domains build and the suite is green, `channel-session.ts`, `session-runner.ts`, and `ooda-runner.ts` (+ its test) are deleted; `runtime.ts` is kept (5 live importers).

**Tech Stack:** TypeScript (ESM, strict), Effect, vitest, nx. Packages: `@roci/core`, `@roci/domain-github`, `@roci/domain-spacemolt`, `roci` (app). Depends on Plans 1–3.

**Scope note:** Plan 4 of 4. **Design decision to confirm:** the channel-session's *in-loop* `dream` compression is dropped — `runCortex` has no `dream` knob, so the `dream: {…}` arg is removed from both phase calls. Memory consolidation still runs in each domain's existing **reflection phase** (`runReflection`), which is unchanged. (Rationale: keeps the active loop lean and matches the spec's "reuse dream" via the reflection phase rather than mid-session. If mid-session dreaming is wanted, add an optional `dream` branch to `runCortex` first.)

## Global Constraints

- ESM `.js` import extensions; Effect typed error channel; vitest.
- Pre-commit runs `nx run-many -t build` — every commit typechecks all four projects clean.
- Do **NOT** delete `runtime.ts` — imported by `model-config.ts`, `cli.ts`, `hypothalamus/types.ts`, `process-runner.ts`, and `runtime.test.ts`.
- Files to delete (only after both phases are rewired and green): `packages/core/src/core/orchestrator/channel-session.ts`, `packages/core/src/core/limbic/hypothalamus/session-runner.ts`, `packages/core/src/core/ooda-runner.ts`, `packages/core/src/core/ooda-runner.test.ts`.
- `runCortex` import path from domains: `@roci/core/cortex/loop.js` (same deep-import style the domains already use for `@roci/core/core/...`).
- Verbatim current call shape (GitHub `phases.ts` ~lines 232-247): `runChannelSession({char, containerId, containerEnv, addDirs: context.containerAddDirs, events, initialState, cadence:"planned-action", dream:{cycleInterval:3,maxIntervalTicks:120}, orientInterval:5}).pipe(Effect.provide(context.domainBundle!))`; result → `Interrupted` loops to `active`, else `break`.
- Verbatim current call shape (SpaceMolt `phases.ts` ~lines 199-211): same but `cadence:"real-time"`, `dream:{cycleInterval:2,maxIntervalTicks:80}`, `orientInterval:3`, `containerEnv: context.containerEnv` unmodified; result → `Interrupted` loops to `active`, else `social`.

---

### Task 1: Provide ModelClientLive + CyberneticsLive at the app level

**Files:**
- Modify: `apps/roci/src/cli.ts` (or wherever the orchestrator's top-level Layer is assembled)

**Interfaces:**
- Consumes: `ModelClientLive` from `@roci/core` (Plan 1), `CyberneticsLive` from `@roci/core` (Plan 2).
- Produces: a runtime layer that satisfies `runCortex`'s `ModelClient | Cybernetics` requirements (the domain Tags are still provided per-phase via `context.domainBundle`).

- [ ] **Step 1: Locate the top-level layer assembly**

Run: `cd /Users/vcarl/workspace/roci && grep -rn "OAuthTokenLive\|CharacterLog\|NodeCommandExecutor\|Layer.merge\|Layer.mergeAll\|Layer.provide" apps/roci/src/cli.ts`
Identify the combined layer provided to `runPhases`/`runOrchestrator` (the one already supplying `CharacterFs`, `CharacterLog`, `CommandExecutor`, `OAuthToken`). Note its exact variable name and construction.

- [ ] **Step 2: Add the two new layers**

Add the import (top of `cli.ts`, with the other `@roci/core` imports):

```typescript
import { ModelClientLive, CyberneticsLive } from "@roci/core"
```

Merge them into the existing top-level layer (use the exact combinator the file already uses; example if it uses `Layer.mergeAll`):

```typescript
// before: Layer.mergeAll(NodeCommandExecutor.layer, CharacterLogLive, OAuthTokenLive, CharacterFsLive, /* ... */)
// after:  add ModelClientLive, CyberneticsLive
Layer.mergeAll(NodeCommandExecutor.layer, CharacterLogLive, OAuthTokenLive, CharacterFsLive, ModelClientLive, CyberneticsLive /* ... */)
```

`ModelClientLive` and `CyberneticsLive` are both `Layer.succeed` with no requirements, so they compose without changing the layer's `RIn`.

- [ ] **Step 3: Typecheck**

Run: `cd /Users/vcarl/workspace/roci && npx nx run roci:build --skip-nx-cache`
Expected: build succeeds (the layers are added but not yet consumed — this just proves they wire in cleanly).

- [ ] **Step 4: Commit**

```bash
cd /Users/vcarl/workspace/roci
git add apps/roci/src/cli.ts
git commit -m "feat(app): provide ModelClientLive + CyberneticsLive in runtime layer"
```

---

### Task 2: Rewire the GitHub active phase to runCortex

**Files:**
- Modify: `packages/domain-github/src/phases.ts`

**Interfaces:**
- Consumes: `runCortex` from `@roci/core/cortex/loop.js`; `getModels` (already imported).

- [ ] **Step 1: Swap the import**

In `packages/domain-github/src/phases.ts`, remove:

```typescript
import { runChannelSession } from "@roci/core/core/orchestrator/channel-session.js"
```

Add (next to the other `@roci/core` imports):

```typescript
import { runCortex } from "@roci/core/cortex/loop.js"
```

- [ ] **Step 2: Replace the engine call**

Replace the `runChannelSession({...})` block (the `const result = yield* runChannelSession(...)` through its `.pipe(Effect.provide(context.domainBundle!))`) with:

```typescript
const result = yield* runCortex({
  char: context.char,
  containerId: context.containerId,
  containerEnv,
  addDirs: context.containerAddDirs,
  events: conn.events as Queue.Queue<unknown>,
  initialState: conn.initialState as unknown,
  cadence: "planned-action",
  workerModels: getModels(context),
  orientInterval: 5,
}).pipe(Effect.provide(context.domainBundle!))
```

The result handling immediately below is unchanged (`updatedConnection` from `result.finalState`; `Interrupted` → `active`, else → `break`). The `dream` arg is intentionally dropped (see scope note).

- [ ] **Step 3: Typecheck the GitHub domain**

Run: `cd /Users/vcarl/workspace/roci && npx nx run @roci/domain-github:build --skip-nx-cache`
Expected: build succeeds. If it complains that `runCortex`'s requirements (`ModelClient`/`Cybernetics`/`CharacterFs`/`CharacterLog`) aren't satisfied, that's expected to resolve at the app layer (Task 1) — the phase's `R` propagates upward; the domain build itself should still typecheck because the phase's return type carries the requirement.

- [ ] **Step 4: Commit**

```bash
cd /Users/vcarl/workspace/roci
git add packages/domain-github/src/phases.ts
git commit -m "feat(domain-github): run active phase on the cortex engine"
```

---

### Task 3: Rewire the SpaceMolt active phase to runCortex

**Files:**
- Modify: `packages/domain-spacemolt/src/phases.ts`

**Interfaces:**
- Consumes: `runCortex` from `@roci/core/cortex/loop.js`; `getModels` (already imported).

- [ ] **Step 1: Swap the import**

Remove:

```typescript
import { runChannelSession } from "@roci/core/core/orchestrator/channel-session.js"
```

Add:

```typescript
import { runCortex } from "@roci/core/cortex/loop.js"
```

- [ ] **Step 2: Replace the engine call**

Replace the `const result = yield* runChannelSession({...}).pipe(Effect.provide(context.domainBundle!))` block with:

```typescript
const result = yield* runCortex({
  char: context.char,
  containerId: context.containerId,
  containerEnv: context.containerEnv,
  addDirs: context.containerAddDirs,
  events: events as Queue.Queue<unknown>,
  initialState,
  cadence: "real-time",
  workerModels: getModels(context),
  orientInterval: 3,
}).pipe(Effect.provide(context.domainBundle!))
```

Result handling below is unchanged (`Interrupted` → `active`, else → `social`; `result.finalState` threaded into the connection).

- [ ] **Step 3: Typecheck the SpaceMolt domain**

Run: `cd /Users/vcarl/workspace/roci && npx nx run @roci/domain-spacemolt:build --skip-nx-cache`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
cd /Users/vcarl/workspace/roci
git add packages/domain-spacemolt/src/phases.ts
git commit -m "feat(domain-spacemolt): run active phase on the cortex engine"
```

---

### Task 4: Delete the dead channel/OODA engine

**Files:**
- Delete: `packages/core/src/core/orchestrator/channel-session.ts`
- Delete: `packages/core/src/core/limbic/hypothalamus/session-runner.ts`
- Delete: `packages/core/src/core/ooda-runner.ts`
- Delete: `packages/core/src/core/ooda-runner.test.ts`

- [ ] **Step 1: Confirm no remaining importers**

Run: `cd /Users/vcarl/workspace/roci && grep -rn "channel-session\|session-runner\|ooda-runner" packages apps --include=*.ts | grep -v "/dist/" | grep -v ".test.ts"`
Expected: **no output** (both phases now import `runCortex`; nothing else referenced these). If any line appears, fix that importer before deleting.

- [ ] **Step 2: Delete the files**

```bash
cd /Users/vcarl/workspace/roci
git rm packages/core/src/core/orchestrator/channel-session.ts \
       packages/core/src/core/limbic/hypothalamus/session-runner.ts \
       packages/core/src/core/ooda-runner.ts \
       packages/core/src/core/ooda-runner.test.ts
```

- [ ] **Step 3: Full build across all projects**

Run: `cd /Users/vcarl/workspace/roci && npx nx run-many -t build --skip-nx-cache`
Expected: all four projects build. If a dangling import of a deleted symbol surfaces (e.g. `SessionConfig`/`SessionResult` in `hypothalamus/types.ts` are now unused — that's fine, unused type exports don't break the build; only an *import* of a deleted file breaks it), fix it by removing the dead import line.

- [ ] **Step 4: Full test suite**

Run: `cd /Users/vcarl/workspace/roci && npm run test`
Expected: all tests pass (the model/cybernetics/cortex suites from Plans 1–3 plus the surviving `model-config`, `runtime`, `stream-normalizer`, `shell-escape`, `skills`, and domain `event-processor` tests; `ooda-runner.test.ts` is gone).

- [ ] **Step 5: Commit**

```bash
cd /Users/vcarl/workspace/roci
git add -A
git commit -m "refactor: delete channel-session, session-runner, ooda-runner (replaced by cortex)"
```

---

### Task 5: End-to-end smoke per domain (manual, documented)

**Files:**
- Create: `docs/cortex-smoke.md`

A runnable checklist to confirm the wired system starts a cortex loop and reaches a delegation against real local model endpoints + a real container. Not a unit test (needs GPU + Docker + a live game/repo); documented so it's reproducible.

- [ ] **Step 1: Write the smoke doc**

Create `docs/cortex-smoke.md` capturing: (a) start three MLX/llama-server endpoints for the tiers per `DEFAULT_CORTEX_MODELS` (ports 8081/8082/8083), (b) `./roci start <character>` for one domain, (c) expected log markers — `hindbrain: <disposition>`, `forebrain: <headline>`, `conscious: <decision>`, `delegating: <task>`, and a cybernetics worker producing output, (d) how to confirm a critical interrupt yields `Interrupted` and re-enters `active`. Reference the testbench (`~/workspace/testbench/llms`) for serving the models and for measuring per-tier latency to tune residency.

- [ ] **Step 2: Commit**

```bash
cd /Users/vcarl/workspace/roci
git add docs/cortex-smoke.md
git commit -m "docs: cortex end-to-end smoke checklist"
```

---

## Self-Review

**Spec coverage (§3 topology, §9 deleted/kept):**
- ✅ §3 cortex engine wired into both domains' active phases; runtime layers (`ModelClient`, `Cybernetics`) provided at the app level alongside existing host-side services — Tasks 1–3.
- ✅ §9 deleted: `channel-session`, `session-runner`, `ooda-runner` (+test) — Task 4. Kept: `runtime.ts`, `model-config.ts`, world interface, interrupts, logging, `dream` (reflection phase), domain bundle Tags.
- ⚠️ Deviation flagged: in-loop `dream` dropped (reflection-phase dream retained) — stated in the scope note for explicit confirmation.

**Placeholder scan:** Task 1 Steps 1–2 reference the exact existing layer by discovery (its name/combinator is environment-specific in `cli.ts`); the example shows the precise edit. No TBDs.

**Type consistency:** Both rewired calls pass the `CortexLoopConfig` field names defined in Plan 3 (`char`, `containerId`, `containerEnv`, `addDirs`, `events`, `initialState`, `cadence`, `workerModels`, `orientInterval`) and consume `result._tag` / `result.finalState` exactly as the prior `runChannelSession` result provided. `getModels(context)` returns `ModelConfig`, matching `CortexLoopConfig.workerModels`. The deleted-files list matches the grep-verified importer map (only `channel-session` was imported by the phases; `session-runner`/`ooda-runner` were imported only by `channel-session`/its own test).
