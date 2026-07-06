# brain/ Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the model-tier × limbic-subsystem axes into one processing-depth hierarchy under a new `brain/` root, behavior-preserving (pure motion + re-wiring).

**Architecture:** A `brain/loop` conductor drives two sibling layers — `brain/limbic/` (pre-conscious: amygdala, autonomic, thalamus, hippocampus incl. its memory cluster, and wm) and `brain/cortex/` (the conscious/deliberative executor) — over a shared `brain/transport` docker-exec turn primitive. The limbic and cortex layers never import each other; the loop mediates the orient→decide seam (now via a forked, loop-owned `runDeliberation`→`applyDeliberation` fiber). This is a directory + import-wiring refactor only; no cognition changes.

**Tech Stack:** TypeScript, Effect service layers, nx monorepo (packages/core = @roci/core), vitest.

## Global Constraints

- **Behavior-preserving:** no model-routing change, `DEFAULT_CORTEX_MODELS` untouched, tier identifiers `hindbrain`/`forebrain`/`conscious` NOT renamed this pass.
- **History:** every move uses `git mv` to preserve history. Two tasks are genuine file-*splits* that cannot be a clean `git mv` and will have weaker blame on the extracted half — Task 8 (extract `session-runner.ts` out of `process-runner.ts`) and Task 10 (split `tiers.ts`). Both are called out at their tasks.
- **Load-bearing invariant — NO cortex→limbic import edge (memory OR wm):** `brain/cortex/**` must never import `memory-*` / `longterm-store` / `hippocampus/memory` **or** `wm-store` / `wm-core` / `limbic/wm` host code. The executor reaches memory only via the in-container `memory` CLI subprocess, and wm only via the in-container `wm` CLI subprocess + the loop-threaded `WM.md` instructions file — never by importing memory or wm host code. Guarded by a grep after every cortex task (see GREP-GUARD).
- **The one cortex→limbic(wm) edge is RESOLVED this pass by lifting provisioning up to the orchestrator** (design ruling — not accept-and-defer). Today `conscious-thought.ts` calls `ensureWmFiles(opts.char)` inside its pre-first-tick provisioning block. That is leftover provisioning: the sibling `memory` CLI and `wm` CLI provisioning were already deliberately lifted OUT of this block up to `apps/roci/src/orchestrator.ts` startup (the no-hot-loading-core-infra rule; see the comment at `conscious-thought.ts:121-126`). Task 8 finishes the job — it removes `ensureWmFiles` from the executor and calls it in the orchestrator adjacent to the existing `provisionWmCli`. The orchestrator sits ABOVE `brain/`, so orchestrator→limbic(wm) is a legitimate caller-above edge (same shape as the orchestrator→`hippocampus/memory` and orchestrator→wm-CLI edges already there). This removes the executor's only limbic import, restoring the no-cortex→limbic-edge invariant for this pass.
- **Base commit:** `b7b4ca6` (the live tip of `feat/wm`). *(Correction: earlier drafts labeled this `e917ab4`; that commit was a divergent parallel line — the refactor was actually built and verified green against `feat/wm`'s tip `b7b4ca6`, which carries the same features as different commits.)* **Branch:** `worktree-historical-reference`. All git via `git -C /Users/vcarl/workspace/roci/.claude/worktrees/historical-reference …`.

### Verified commands (from `package.json` / `nx.json`; package manager is **pnpm@9.15.9**)

- **DEPS BOOTSTRAP (worktree caveat — do this ONCE first):** this worktree has **no `node_modules`**, so `nx` / `vitest` / `tsc` are not runnable here as-is. Before any typecheck/test step, run `pnpm install` at the repo root — OR execute the plan in a checkout where deps already exist. Until deps are installed, every verify step below is a no-op.
- **TYPECHECK (cache-safe, whole workspace incl. domain packages):**
  `pnpm exec nx run-many -t typecheck --skip-nx-cache`
  (`--skip-nx-cache` is mandatory: the nx cache masks cross-package symbol breaks — a downstream package can read green while a moved export dangles.)
  No-nx fallback (per-package, bypasses nx): `pnpm --filter @roci/core exec tsc --noEmit`. For tasks that change the package's public path (Task 11, Task 13), also typecheck the domain packages: `pnpm exec nx run-many -t typecheck --skip-nx-cache` covers them.
- **TEST (one or more files):** `pnpm exec vitest --run <path> [<path> …]`
- **TEST (full suite):** `pnpm exec vitest --run`
- **GREP-GUARD (cortex→limbic memory OR wm edge — expect zero output):**
  `grep -rnE "hippocampus/memory|memory-gateway|longterm-store|memory-(cli|embed|sql|format|args)|wm-store|wm-core|limbic/wm" packages/core/src/brain/cortex/ || echo "CLEAN: no cortex->limbic (memory or wm) edge"`
- **COMMIT:** `git -C <root> commit --no-verify -m "…"` — `--no-verify` is required only because the repo pre-commit hook runs `nx run-many -t build`, which fails in this deps-less worktree. Once run where deps exist, drop `--no-verify`.

### Import-path mechanics (read once)

- Internal imports are **relative with `.js` extensions** (e.g. `from "../hypothalamus/process-runner.js"`, `from "./longterm-store.js"`).
- **Intra-directory imports (`./foo.js`) stay valid when a whole directory moves together** — do NOT repoint them. Only **cross-directory** importers need repointing. Each task's "Repoint" list contains only the cross-dir edits.
- The package public API barrel is `packages/core/src/index.ts`; several moves touch its re-export lines (listed per task).
- Current directory prefixes: limbic lives at `packages/core/src/core/limbic/`; the engine at `packages/core/src/cortex/`; conscious-tier files at `packages/core/src/conscious/`. Target flattens all under `packages/core/src/brain/`.

---

## Task 1: `brain/transport` — shared base transport

Move the docker-exec turn primitive to a layer-neutral shared home. `process-runner.ts` moves **whole** (its session-executor exports ride along; they are extracted to cortex in Task 8).

**Files:**
- Move: `packages/core/src/core/limbic/hypothalamus/transport.ts` → `packages/core/src/brain/transport/transport.ts`
- Move: `…/hypothalamus/payload.ts` → `packages/core/src/brain/transport/payload.ts`
- Move: `…/hypothalamus/types.ts` → `packages/core/src/brain/transport/types.ts`
- Move: `…/hypothalamus/process-runner.ts` → `packages/core/src/brain/transport/process-runner.ts`
- Move (tests): `…/hypothalamus/transport.test.ts`, `…/hypothalamus/payload.test.ts`, `…/hypothalamus/process-runner.test.ts` → `packages/core/src/brain/transport/`
- Modify (repoint): the cross-dir importers below.

**Interfaces — Consumes / Produces:**
- `process-runner.ts` exports: `runTurn`, `buildExecArgs` (base transport — stay here) and `runOpenCodeSessionTurn`, `firstSessionId`, `sessionNotFoundMessage` (session executor — temporarily here, extracted in Task 8).
- `types.ts` exports: `TurnConfig`, `TurnResult`. `transport.ts` exports: `runTransport`, `HEARTBEAT_INTERVAL_MS`, `runHeartbeat`, `parseStreamJson`, `isAuthError`, `TransportInput`. `payload.ts` exports the command builders (`buildInnerCommand`, `normalizerFor`, `buildOpenCodeSessionCommand`, `openCodeBodyEnv`, `wrapWithTimeout`, `OPENCODE_DISABLE_NETWORK_ENV`, …).
- Note: `transport.ts` ↔ `payload.ts` ↔ `process-runner.ts` import each other with `./`-relative paths and all move together — those stay valid, no repoint.

- [ ] **Step 1 — git mv the four modules + three tests**
```
git -C <root> mv packages/core/src/core/limbic/hypothalamus/transport.ts packages/core/src/brain/transport/transport.ts
git -C <root> mv packages/core/src/core/limbic/hypothalamus/payload.ts packages/core/src/brain/transport/payload.ts
git -C <root> mv packages/core/src/core/limbic/hypothalamus/types.ts packages/core/src/brain/transport/types.ts
git -C <root> mv packages/core/src/core/limbic/hypothalamus/process-runner.ts packages/core/src/brain/transport/process-runner.ts
git -C <root> mv packages/core/src/core/limbic/hypothalamus/transport.test.ts packages/core/src/brain/transport/transport.test.ts
git -C <root> mv packages/core/src/core/limbic/hypothalamus/payload.test.ts packages/core/src/brain/transport/payload.test.ts
git -C <root> mv packages/core/src/core/limbic/hypothalamus/process-runner.test.ts packages/core/src/brain/transport/process-runner.test.ts
```

- [ ] **Step 2 — repoint cross-dir importers of `process-runner.js`** (`runTurn` / `runOpenCodeSessionTurn`):
  - `core/limbic/hippocampus/dream.ts`: `from "../hypothalamus/process-runner.js"` → `from "../../../brain/transport/process-runner.js"`
  - `core/limbic/hippocampus/macro.ts`: same old → `from "../../../brain/transport/process-runner.js"`
  - `core/limbic/hippocampus/retrospect.ts`: same old → `from "../../../brain/transport/process-runner.js"`
  - `core/limbic/hippocampus/synthesis-bootstrap.ts`: same old → `from "../../../brain/transport/process-runner.js"`
  - `conscious/conscious-thought.ts`: `from "../core/limbic/hypothalamus/process-runner.js"` → `from "../brain/transport/process-runner.js"`

- [ ] **Step 3 — repoint cross-dir importers of `types.js`** (`TurnConfig`/`TurnResult`):
  - `conscious/conscious-thought.ts`: `from "../core/limbic/hypothalamus/types.js"` → `from "../brain/transport/types.js"`
  - `cortex/loop.ts`: `from "../core/limbic/hypothalamus/types.js"` → `from "../brain/transport/types.js"`

- [ ] **Step 4 — repoint moved tests' own imports** if any reference `../` paths that changed (they moved with their modules; only cross-dir refs need fixing — check each test's top imports).

- [ ] **Step 5 — typecheck:** `pnpm exec nx run-many -t typecheck --skip-nx-cache` → expect green.
- [ ] **Step 6 — tests:** `pnpm exec vitest --run packages/core/src/brain/transport/` → expect green.
- [ ] **Step 7 — commit:**
```
git -C <root> add -A && git -C <root> commit --no-verify -m "refactor(brain): move base transport to brain/transport"
```

---

## Task 2: Neutral homes — `install-cli`, skill loader/types

Two layer-neutral pieces. **Decision:** `install-cli.ts` → `services/` (already the neutral cross-cutting home; putting it in `hippocampus/memory/` would create a cortex(`frontier-cli`)→limbic edge). `skills/loader.ts` + `skills/types.ts` **stay under `skills/`** (already neutral) — no move, stated explicitly to minimize churn.

**Files:**
- Move: `packages/core/src/conscious/install-cli.ts` → `packages/core/src/services/install-cli.ts`
- (No move for `skills/loader.ts`, `skills/types.ts`.)
- Modify (repoint): importers of `install-cli`.

**Interfaces — Consumes / Produces:** `install-cli.ts` exports `installContainerCli`. Cross-dir importers (grep-verified): `conscious/frontier-cli.ts`, `conscious/memory-cli.ts`, `conscious/wm-cli.ts`.

- [ ] **Step 1 — git mv:**
```
git -C <root> mv packages/core/src/conscious/install-cli.ts packages/core/src/services/install-cli.ts
```
(Move `conscious/install-cli.test.ts` too if present: `ls packages/core/src/conscious/install-cli.test.ts` — none currently, skip if absent.)

- [ ] **Step 2 — repoint the three importers** (all currently `from "./install-cli.js"`):
  - `conscious/frontier-cli.ts`: → `from "../services/install-cli.js"`
  - `conscious/memory-cli.ts`: → `from "../services/install-cli.js"`
  - `conscious/wm-cli.ts`: → `from "../services/install-cli.js"`

- [ ] **Step 3 — typecheck:** `pnpm exec nx run-many -t typecheck --skip-nx-cache` → green.
- [ ] **Step 4 — tests (touched files):** `pnpm exec vitest --run packages/core/src/conscious/frontier-cli.test.ts packages/core/src/conscious/memory-cli.test.ts packages/core/src/conscious/wm-cli.test.ts` → green.
- [ ] **Step 5 — commit:**
```
git -C <root> add -A && git -C <root> commit --no-verify -m "refactor(brain): install-cli to neutral services/ home; skills loader stays"
```

---

## Task 3: `brain/limbic/hippocampus/memory` — the 7-file long-term memory cluster

Memory formation/retrieval is hippocampus-owned. The 7 files move together; intra-cluster `./`-imports stay valid.

**Files (move each + its `.test.ts`):**
- `conscious/memory-gateway.ts`, `conscious/longterm-store.ts`, `conscious/memory-cli.ts`, `conscious/memory-embed.ts`, `conscious/memory-sql.ts`, `conscious/memory-format.ts`, `conscious/memory-args.ts` → `packages/core/src/brain/limbic/hippocampus/memory/`
- Tests: `longterm-store.test.ts`, `memory-args.test.ts`, `memory-cli.test.ts`, `memory-embed.test.ts`, `memory-format.test.ts`, `memory-gateway.test.ts`, `memory-sql.test.ts` (all present) → same dir.

**Interfaces — Consumes / Produces:** `memory-gateway.ts` exports `MemoryGateway`, `observeMemories`, `orientMemories`, `decideMemories`, `evaluateMemories`, `decideQuery`, `evaluateQuery`, `orientQuery`. `longterm-store.ts` exports `LongtermStore` + friends and imports `MEMORY_CLI_PATH` from `./memory-cli.js`. `memory-cli.ts` imports `../services/install-cli.js` (from Task 2 — becomes `../../../../services/install-cli.js` after the move; repoint in Step 2).

- [ ] **Step 1 — git mv the 7 modules + 7 tests** into `packages/core/src/brain/limbic/hippocampus/memory/` (one `git mv` per file, e.g. `git -C <root> mv packages/core/src/conscious/memory-gateway.ts packages/core/src/brain/limbic/hippocampus/memory/memory-gateway.ts`, … for all 14).

- [ ] **Step 2 — repoint intra-cluster imports that reference NON-cluster modules** (cluster→outside):
  - `memory-cli.ts`: `from "../services/install-cli.js"` → `from "../../../../services/install-cli.js"`
  - Check each moved file's top imports for any other `../`-to-`conscious`/`core`/`services`/`logging` path and add `../../../` depth accordingly (they were at `conscious/`, depth 1 below `src`; now at `brain/limbic/hippocampus/memory/`, depth 4). Common ones: `../services/CharacterFs.js` → `../../../../services/CharacterFs.js`; `../logging/log-writer.js` → `../../../../logging/log-writer.js`. Grep each file: `grep -n "from \"\.\./" <file>` and re-depth.

- [ ] **Step 3 — repoint cross-dir importers of the cluster:**
  - `cortex/loop.ts`: `from "../conscious/memory-gateway.js"` → `from "../brain/limbic/hippocampus/memory/memory-gateway.js"`
  - `conscious/identity-context.ts`: `from "./memory-gateway.js"` → `from "../brain/limbic/hippocampus/memory/memory-gateway.js"` (identity-context itself moves in Task 5; this import re-relativizes to `./memory/memory-gateway.js` there)
  - `core/limbic/hippocampus/macro.ts`: `from "../../../conscious/longterm-store.js"` → `from "./memory/longterm-store.js"` (macro is already under `core/limbic/hippocampus/`; it moves to `brain/limbic/hippocampus/` in Task 5, at which point `./memory/longterm-store.js` is correct — but at THIS task macro is still at `core/limbic/hippocampus/`, so use `from "../../../brain/limbic/hippocampus/memory/longterm-store.js"`; it re-relativizes to `./memory/longterm-store.js` in Task 5)
  - `core/orchestrator/planned-action.ts`: `from "../limbic/hippocampus/… longterm-store"`? verify exact — grep shows it imports `longterm-store.js`; repoint to `from "../../brain/limbic/hippocampus/memory/longterm-store.js"`

- [ ] **Step 3b — repoint cross-PACKAGE deep-path importers in `apps/roci/src/orchestrator.ts`** (it imports core via deep `@roci/core/...` paths, not the barrel):
  - line 12 `import { provisionMemoryCli } from "@roci/core/conscious/memory-cli.js"` → `from "@roci/core/brain/limbic/hippocampus/memory/memory-cli.js"`
  - line 14 `import { DEFAULT_EMBED_BASE_URL } from "@roci/core/conscious/memory-embed.js"` → `from "@roci/core/brain/limbic/hippocampus/memory/memory-embed.js"`

- [ ] **Step 4 — typecheck:** `pnpm exec nx run-many -t typecheck --skip-nx-cache` → green (covers `apps/roci`).
- [ ] **Step 5 — tests:** `pnpm exec vitest --run packages/core/src/brain/limbic/hippocampus/memory/` → green.
- [ ] **Step 6 — commit:**
```
git -C <root> add -A && git -C <root> commit --no-verify -m "refactor(brain): memory cluster to limbic/hippocampus/memory (hippocampus-owned)"
```

---

## Task 4: `brain/limbic/wm` — procedural working memory

Move wm BEFORE hippocampus so `identity-context` (Task 5) lands importing the final wm path.

**Files (move + tests):**
- `conscious/wm-core.ts`, `conscious/wm-store.ts`, `conscious/wm-cli.ts` → `packages/core/src/brain/limbic/wm/`
- Tests: `wm-core.test.ts`, `wm-store.test.ts`, `wm-cli.test.ts` → same dir.

**Interfaces — Consumes / Produces:** `wm-store.ts` exports `ensureWmFiles`, `readWm`, `renderOpenTodoTree`, `mutateWm`, `seedWmPlan`, `closePlanTodos`, `discardDeadPlanTodos`, `drainWmDeltas`, `WM_JSON_FILE`, `WM_MD_FILE`, `WM_PROMPT_CAP`. `wm-core.ts` exports the state machine + `WmDelta`/`WmTodo`/`WmFile` types. `wm-cli.ts` imports `../services/install-cli.js` (Task 2). Cross-dir importers (grep-verified): `wm-store.js` ← `conscious/conscious-thought.ts`, `conscious/identity-context.ts`, `cortex/loop.ts`; `wm-core.js` ← `cortex/loop.ts` (+ intra: `wm-store.ts`, `wm-cli.ts`).

- [ ] **Step 1 — git mv 3 modules + 3 tests** into `packages/core/src/brain/limbic/wm/`.

- [ ] **Step 2 — re-depth non-cluster imports inside the moved files** (were depth-1 at `conscious/`, now depth-3 at `brain/limbic/wm/`): e.g. `wm-cli.ts` `from "../services/install-cli.js"` → `from "../../../services/install-cli.js"`; `wm-store.ts` `from "../services/CharacterFs.js"` → `from "../../../services/CharacterFs.js"`, `from "../core/types.js"` → `from "../../../core/types.js"`, `from "../logging/episodes.js"` → `from "../../../logging/episodes.js"`. Grep-and-re-depth each moved file.

- [ ] **Step 3 — repoint cross-dir importers:**
  - `cortex/loop.ts`: `from "../conscious/wm-store.js"` → `from "../brain/limbic/wm/wm-store.js"`; `from "../conscious/wm-core.js"` → `from "../brain/limbic/wm/wm-core.js"`
  - `conscious/conscious-thought.ts`: `from "./wm-store.js"` → `from "../brain/limbic/wm/wm-store.js"` *(TEMPORARY repoint to keep the tree green THIS task; Task 8 SEVERS this import entirely by lifting `ensureWmFiles` to the orchestrator — this is the cortex→limbic(wm) edge being resolved, not carried)*
  - `conscious/identity-context.ts`: `from "./wm-store.js"` → `from "../brain/limbic/wm/wm-store.js"` (re-relativizes to `../wm/wm-store.js` in Task 5)

- [ ] **Step 3b — repoint the cross-PACKAGE deep-path importer in `apps/roci/src/orchestrator.ts`:**
  - line 13 `import { provisionWmCli } from "@roci/core/conscious/wm-cli.js"` → `from "@roci/core/brain/limbic/wm/wm-cli.js"`

- [ ] **Step 4 — typecheck:** `pnpm exec nx run-many -t typecheck --skip-nx-cache` → green (covers `apps/roci`).
- [ ] **Step 5 — tests:** `pnpm exec vitest --run packages/core/src/brain/limbic/wm/` → green.
- [ ] **Step 6 — commit:**
```
git -C <root> add -A && git -C <root> commit --no-verify -m "refactor(brain): wm procedural-memory subsystem to limbic/wm"
```

---

## Task 5: `brain/limbic/hippocampus` — reflection/growth stages, growth-store, identity-context

Move the hippocampus reflection modules and the two `conscious/` growth pieces into their final home. Memory (Task 3) and wm (Task 4) are already placed, so cross-imports land final.

**Files:**
- Move dir contents: `core/limbic/hippocampus/{dream.ts, retrospect.ts, macro.ts, synthesis-bootstrap.ts, index.ts}` + `prompts/*` + tests (`dream.test.ts`, `macro.test.ts`, `retrospect.test.ts`, `synthesis-bootstrap.test.ts`) → `packages/core/src/brain/limbic/hippocampus/`
- Move: `conscious/growth-store.ts` (+ `growth-store.test.ts`) → `packages/core/src/brain/limbic/hippocampus/growth-store.ts`
- Move: `conscious/identity-context.ts` (+ `identity-context.test.ts`) → `packages/core/src/brain/limbic/hippocampus/identity-context.ts`
- Move: `skills/consolidate.md` → `packages/core/src/brain/limbic/hippocampus/prompts/consolidate.md`

**Interfaces — Consumes / Produces:** `dream.ts` exports `dream`, `DIARY_TARGET_LINES`, `REFLECTION_TURN_TIMEOUT_MS`, `CULL_TURN_TIMEOUT_MS`, `REFLECTION_CONTEXT_MAX`. `retrospect.ts` exports `retrospect`; `macro.ts` exports `macro`; `synthesis-bootstrap.ts` exports `bootstrapSynthesis`. `growth-store.ts` exports the proposals-store API (`readProposals`, `proposalsJsonlPath`, `AdjudicationDoc`, …). `identity-context.ts` exports `readIdentityContext`, `IDENTITY_PLACEHOLDERS`. `dream.ts` loads `consolidate.md` via `loadTemplate(path.join(SKILLS_DIR, "consolidate.md"))` — its `SKILLS_DIR` must now point at the local `prompts/`.

- [ ] **Step 1 — git mv** the hippocampus dir files + prompts + tests to `brain/limbic/hippocampus/`; then `growth-store.ts`/`identity-context.ts` (+tests) into the same dir; then `consolidate.md` into `brain/limbic/hippocampus/prompts/`.

- [ ] **Step 2 — fix `dream.ts` `SKILLS_DIR` / consolidate path.** It resolves `consolidate.md` from a skills dir; point it at the co-located prompt: change the `SKILLS_DIR`/path so `path.join(SKILLS_DIR, "consolidate.md")` resolves to `brain/limbic/hippocampus/prompts/consolidate.md` (e.g. `const SKILLS_DIR = path.resolve(import.meta.dirname, "prompts")` — verify against the existing `dream-diary.md` prompt loads, which already read from a prompts dir; consolidate.md now lives alongside them).

- [ ] **Step 3 — re-relativize/repoint imports inside moved files:**
  - `dream.ts`/`macro.ts`/`retrospect.ts`/`synthesis-bootstrap.ts`: `from "../../../brain/transport/process-runner.js"` (set in Task 1) → `from "../../../brain/transport/process-runner.js"` stays correct only if depth unchanged — verify: these were at `core/limbic/hippocampus/` (depth 3) and move to `brain/limbic/hippocampus/` (also depth 3), so `../../../brain/…` paths are UNCHANGED. Confirm depth parity, no edit needed for transport imports.
  - `macro.ts`: `longterm-store` import set in Task 3 → re-relativize to `from "./memory/longterm-store.js"`; growth-store import → `from "./growth-store.js"`.
  - `retrospect.ts`: growth-store import → `from "./growth-store.js"`.
  - `synthesis-bootstrap.ts`: `from "./macro.js"` stays (intra-dir).
  - `identity-context.ts`: memory-gateway → `from "./memory/memory-gateway.js"`; wm-store → `from "../wm/wm-store.js"`.
  - `growth-store.ts`: `from "../services/skills-core.js"` → `from "../../../services/skills-core.js"`; `from "../skills/types.js"` → `from "../../../skills/types.js"` (re-depth from `conscious/` depth-1 to `brain/limbic/hippocampus/` depth-3).

- [ ] **Step 4 — repoint cross-dir importers (still in their old homes):**
  - `core/orchestrator/planned-action.ts`: `dream`/`retrospect`/`macro`/`bootstrapSynthesis` imports `from "../limbic/hippocampus/…"` → `from "../../brain/limbic/hippocampus/…"`
  - `core/model-config.ts`: `from "…/limbic/hippocampus/synthesis-bootstrap.js"` → `from "…/brain/limbic/hippocampus/synthesis-bootstrap.js"` (verify exact relative depth)
  - `services/CharacterFs.ts`: `from "…/limbic/hippocampus/macro.js"` → `from "../brain/limbic/hippocampus/macro.js"`
  - `cortex/loop.ts`: `from "../conscious/identity-context.js"` → `from "../brain/limbic/hippocampus/identity-context.js"`

- [ ] **Step 5 — update the limbic barrel** `core/limbic/index.ts`: its hippocampus re-exports (`dream`, `DreamType`, `DIARY_TARGET_LINES`, …) now come from `../../brain/limbic/hippocampus/index.js` — repoint that line. (The barrel file itself relocates in Task 6.)

- [ ] **Step 6 — typecheck:** `pnpm exec nx run-many -t typecheck --skip-nx-cache` → green.
- [ ] **Step 7 — tests:** `pnpm exec vitest --run packages/core/src/brain/limbic/hippocampus/` → green.
- [ ] **Step 8 — commit:**
```
git -C <root> add -A && git -C <root> commit --no-verify -m "refactor(brain): hippocampus reflection/growth + identity-context to limbic/hippocampus"
```

---

## Task 6: `brain/limbic/thalamus` + `brain/limbic/amygdala` (+ relocate the limbic barrel)

Pure moves — the loop still resolves the individual tags from the new paths (facade swap is Task 11).

**Files:**
- Move: `core/limbic/thalamus/` (`event-processor.ts`, `situation-classifier.ts`, `index.ts` + any tests) → `packages/core/src/brain/limbic/thalamus/`
- Move: `core/limbic/amygdala/` (`interrupt.ts`, `index.ts` + any tests) → `packages/core/src/brain/limbic/amygdala/`
- Move: `core/limbic/index.ts` → `packages/core/src/brain/limbic/index.ts` and `core/limbic/LIMBIC.md` stays for Task 11 (docs) — leave it; move only the barrel here.

**Interfaces — Consumes / Produces:** thalamus exports `EventProcessorTag`, `SituationClassifierTag` (+ interface types); amygdala exports `InterruptRegistryTag`, `createInterruptRegistry`, `InterruptRule`, `InterruptRegistry`. Cross-dir importers (grep-verified, import subsystem files directly): `core/domain-bundle.ts`, `core/orchestrator/lifecycle.ts`, `core/orchestrator/planned-action.ts`, `cortex/loop.ts`, `template-domain/{event-processor.ts, situation-classifier.ts, interrupt-rules.ts}`.

- [ ] **Step 1 — git mv** both subdirs (with their `index.ts` and any tests) and the barrel `core/limbic/index.ts` → `brain/limbic/index.ts`.

- [ ] **Step 2 — update the moved barrel** `brain/limbic/index.ts` internal re-export paths: thalamus/amygdala now `./thalamus/index.js` / `./amygdala/index.js` (intra, unchanged); hypothalamus tempo re-export currently `./hypothalamus/index.js` — hypothalamus/tempo moves in Task 7, so temporarily point at `../../core/limbic/hypothalamus/index.js` (still present) OR defer that one line to Task 7. Hippocampus re-export → `./hippocampus/index.js` (now intra, since hippocampus moved in Task 5). Adjust to keep it compiling.

- [ ] **Step 3 — repoint cross-dir importers** (subsystem-file-direct imports):
  - `core/domain-bundle.ts`: `from "./limbic/amygdala/interrupt.js"` → `from "../brain/limbic/amygdala/interrupt.js"`; `from "./limbic/thalamus/event-processor.js"` → `from "../brain/limbic/thalamus/event-processor.js"`; `from "./limbic/thalamus/situation-classifier.js"` → `from "../brain/limbic/thalamus/situation-classifier.js"`
  - `core/orchestrator/lifecycle.ts`, `core/orchestrator/planned-action.ts`: `from "../limbic/thalamus/…"`/`"../limbic/amygdala/…"` → `from "../../brain/limbic/thalamus/…"` / `"../../brain/limbic/amygdala/…"`
  - `cortex/loop.ts`: `from "../core/limbic/thalamus/event-processor.js"` → `from "../brain/limbic/thalamus/event-processor.js"`; `situation-classifier.js` likewise; `from "../core/limbic/amygdala/interrupt.js"` → `from "../brain/limbic/amygdala/interrupt.js"`
  - `template-domain/event-processor.ts`, `template-domain/situation-classifier.ts`, `template-domain/interrupt-rules.ts`: repoint their `…/core/limbic/thalamus|amygdala/…` imports to `…/brain/limbic/…` (verify each relative depth).

- [ ] **Step 4 — typecheck:** `pnpm exec nx run-many -t typecheck --skip-nx-cache` → green.
- [ ] **Step 5 — tests:** `pnpm exec vitest --run packages/core/src/brain/limbic/thalamus/ packages/core/src/brain/limbic/amygdala/` (plus any that reference these) → green.
- [ ] **Step 6 — commit:**
```
git -C <root> add -A && git -C <root> commit --no-verify -m "refactor(brain): thalamus + amygdala to limbic; relocate limbic barrel"
```

---

## Task 7: `brain/limbic/autonomic` — assembled (tempo + cadence + drives)

Assemble the reflexive housekeeping subsystem from three currently-separate files.

**Files:**
- Move: `core/limbic/hypothalamus/tempo.ts` → `packages/core/src/brain/limbic/autonomic/tempo.ts`
- Move: `skills/cadence.ts` → `packages/core/src/brain/limbic/autonomic/cadence.ts`
- Move: `core/drives.ts` → `packages/core/src/brain/limbic/autonomic/drives.ts`
- Move any co-located tests (`drives.test.ts`/`cadence.test.ts` if present — `ls` to check).
- After this, `core/limbic/hypothalamus/` should contain only `runtime.ts`, `sdk-payload.ts`, `sdk-runner/`, `index.ts` (moved in Task 8). Verify the now-empty-ish dir.

**Interfaces — Consumes / Produces:** `tempo.ts` exports `TempoConfig`, `TempoBase`, `StateMachineTempo`, `PlannedActionTempo`. `cadence.ts` exports `Cadence`, `getCadenceGuidance`. `drives.ts` exports `TEMPLATE_DRIVES`, `CORE_DRIVE_NAMES`, `renderDriveLines`, `parseDriveNames`, `drivesFile`, `DomainDrive`. Cross-dir importers (grep-verified): tempo ← `core/orchestrator/planned-action.ts` (+ limbic barrel); cadence ← `cortex/loop.ts`, `cortex/tiers.ts`, `skills/index.ts`; drives ← `cortex/loop.ts`, `cortex/tiers.ts`, `index.ts`, `services/CharacterFs.ts`, `core/character-scaffold.ts`.

- [ ] **Step 1 — git mv** the three files (+tests) into `brain/limbic/autonomic/`.

- [ ] **Step 2 — re-depth internal imports** in the moved files (drives was `core/` depth-1, cadence `skills/` depth-1, tempo `core/limbic/hypothalamus/` depth-3; all now `brain/limbic/autonomic/` depth-3). Grep each for `from "../` and fix.

- [ ] **Step 3 — repoint cross-dir importers:**
  - `core/orchestrator/planned-action.ts`: tempo `from "../limbic/hypothalamus/tempo.js"` → `from "../../brain/limbic/autonomic/tempo.js"`
  - `cortex/loop.ts`: `from "../skills/cadence.js"` → `from "../brain/limbic/autonomic/cadence.js"`; `from "../core/drives.js"` → `from "../brain/limbic/autonomic/drives.js"`
  - `cortex/tiers.ts`: cadence + drives → `from "../brain/limbic/autonomic/cadence.js"` / `"../brain/limbic/autonomic/drives.js"`
  - `skills/index.ts`: `from "./cadence.js"` → `from "../brain/limbic/autonomic/cadence.js"`
  - `index.ts` (barrel): line 82-83 drives re-exports `from "./core/drives.js"` → `from "./brain/limbic/autonomic/drives.js"`
  - `services/CharacterFs.ts`: `from "../core/drives.js"`? → `from "./…/brain/limbic/autonomic/drives.js"` (services is depth-1: `from "../brain/limbic/autonomic/drives.js"`)
  - `core/character-scaffold.ts`: `from "./drives.js"` → `from "../brain/limbic/autonomic/drives.js"`
  - limbic barrel `brain/limbic/index.ts`: the tempo re-export line (deferred in Task 6) → `from "./autonomic/tempo.js"`.

- [ ] **Step 4 — typecheck:** `pnpm exec nx run-many -t typecheck --skip-nx-cache` → green.
- [ ] **Step 5 — tests:** `pnpm exec vitest --run` (drives/cadence/tempo are widely referenced; run the full suite here) → green.
- [ ] **Step 6 — commit:**
```
git -C <root> add -A && git -C <root> commit --no-verify -m "refactor(brain): assemble limbic/autonomic (tempo + cadence + drives)"
```

---

## Task 8: `brain/cortex/conscious` — executor + session-runner split

Extract the session-executor exports out of `brain/transport/process-runner.ts` (genuine split, weaker blame on the extracted file), move the executor files, **and sever the cortex→limbic(wm) edge by lifting `ensureWmFiles` to the orchestrator.** **Run the GREP-GUARD at the end.**

This task is "move + one provisioning lift," not strictly pure-motion — the single intentional behavior nuance (wm-file seeding timing) is called out in Step 4b.

**Files:**
- Create: `packages/core/src/brain/cortex/conscious/session-runner.ts` (extract `runOpenCodeSessionTurn`, `firstSessionId`, `sessionNotFoundMessage` from `brain/transport/process-runner.ts`).
- Modify: `brain/transport/process-runner.ts` (remove the extracted exports; keep `runTurn`, `buildExecArgs`).
- Modify: `conscious/conscious-thought.ts` — REMOVE the `ensureWmFiles` import (line 20) and its call (line 109); the executor no longer touches wm host code.
- Modify: `apps/roci/src/orchestrator.ts` — ADD the `ensureWmFiles(char)` provisioning call in the eager startup block adjacent to `provisionWmCli` (line 185).
- Move: `core/limbic/hypothalamus/runtime.ts` → `packages/core/src/brain/cortex/conscious/runtime.ts`
- Move: `core/limbic/hypothalamus/sdk-payload.ts` → `packages/core/src/brain/cortex/conscious/sdk-payload.ts`
- Move: `core/limbic/hypothalamus/sdk-runner/` → `packages/core/src/brain/cortex/conscious/sdk-runner/`
- Move: `conscious/conscious-thought.ts`, `conscious/opencode-config.ts`, `conscious/frontier-cli.ts` (+ their tests: `conscious-thought.test.ts`, `opencode-config.test.ts`, `opencode-session.smoke.test.ts`, `frontier-cli.test.ts`, `runtime.test.ts`, `sdk-payload.test.ts`, `sdk-runner/sdk-runner-protocol.test.ts`) → `packages/core/src/brain/cortex/conscious/`
- Delete: `core/limbic/hypothalamus/index.ts` (its tempo re-export moved in Task 7; verify it exports nothing still-needed, else fold remaining exports into the new homes). Remove the now-empty `core/limbic/hypothalamus/`.

**Interfaces — Consumes / Produces:** `session-runner.ts` exports `runOpenCodeSessionTurn(config, resume?)`, `firstSessionId(raw)`, `sessionNotFoundMessage(resume?)` and imports its command-builders from `../../transport/payload.js` + `runTransport` from `../../transport/transport.js` (allowed cortex→transport down-edge). `conscious-thought.ts` exports `ConsciousThought`, `ConsciousThoughtLive`, `ConsciousThoughtTest`, `ConsciousTurnConfig`, `ProvisionOpts`; after this task it imports `runOpenCodeSessionTurn` (now `./session-runner.js`) and `TurnConfig`/`TurnResult` (`../../transport/types.js`) and **no longer imports `ensureWmFiles` / any wm host code** (the edge is severed). `runtime.ts` exports `AgentRuntime`, `modelRuntime`, `runtimeBinary`, `runtimeBaseArgs`, `AnyModel`. `frontier-cli.ts` imports `runtime.js` (now intra `./runtime.js`), `sdk-payload.js` (intra `./sdk-payload.js`), `../services/install-cli.js` (re-depth). `ensureWmFiles(char)` (from `@roci/core/brain/limbic/wm/wm-store.js`, settled by Task 5's re-relativize) is now called by `apps/roci/src/orchestrator.ts` — idempotent, failure-tolerant provisioning.

- [ ] **Step 1 — extract `session-runner.ts`:** create `brain/cortex/conscious/session-runner.ts` with the three exports cut from `brain/transport/process-runner.ts`. In it, import `buildOpenCodeSessionCommand`/`openCodeBodyEnv`/`wrapWithTimeout`/`OPENCODE_DISABLE_NETWORK_ENV` from `../../transport/payload.js`, `runTransport` (+ helpers) from `../../transport/transport.js`, `TurnConfig`/`TurnResult` from `../../transport/types.js`, and any logging/normalizer from their absolute homes. Remove those three exports (and now-unused imports) from `process-runner.ts`. **Note in the commit that blame on `session-runner.ts` is fresh (split, not `git mv`).**

- [ ] **Step 2 — git mv** `runtime.ts`, `sdk-payload.ts`, `sdk-runner/`, and the three `conscious/` executor files (+ all listed tests) into `brain/cortex/conscious/`.

- [ ] **Step 3 — re-depth/repoint moved-file imports:**
  - `conscious-thought.ts`: `from "../brain/transport/process-runner.js"` → `from "./session-runner.js"` (for `runOpenCodeSessionTurn`); `from "../brain/transport/types.js"` → `from "../../transport/types.js"`; other `../services|../logging|../model|../core` → re-depth to `../../…`. **Do NOT repoint the `wm-store` import — it is being DELETED in Step 4b.**
  - `frontier-cli.ts`: `from "../core/limbic/hypothalamus/runtime.js"` → `from "./runtime.js"`; `from "../core/limbic/hypothalamus/sdk-payload.js"` → `from "./sdk-payload.js"`; `from "../services/install-cli.js"` → `from "../../services/install-cli.js"`; `Docker` → re-depth.
  - `opencode-config.ts`: re-depth any `../` imports to `../../`.
  - `runtime.ts`: re-depth its imports (it referenced `Claude`/model types) to `../../…`.

- [ ] **Step 4 — repoint cross-dir importers still outside:**
  - `cortex/loop.ts`: `from "../conscious/conscious-thought.js"` → `from "../brain/cortex/conscious/conscious-thought.js"`; `from "../conscious/opencode-config.js"` (`consciousModelLabel`) → `from "../brain/cortex/conscious/opencode-config.js"`
  - `core/model-config.ts`: `from "…/limbic/hypothalamus/runtime.js"` → `from "…/brain/cortex/conscious/runtime.js"`
  - `index.ts` (barrel): lines 88-89 `from "./conscious/conscious-thought.js"` → `from "./brain/cortex/conscious/conscious-thought.js"`
  - `apps/roci/src/orchestrator.ts` (cross-package deep path): line 11 `import { provisionConsciousProvider } from "@roci/core/conscious/opencode-config.js"` → `from "@roci/core/brain/cortex/conscious/opencode-config.js"`

- [ ] **Step 4b — SEVER the wm edge + lift provisioning to the orchestrator** (the design ruling):
  - In `conscious-thought.ts`, DELETE `import { ensureWmFiles } from "./wm-store.js"` (line 20, already pointed at the wm path by Task 5) and DELETE the `yield* ensureWmFiles(opts.char)` call (line 109) from the pre-first-tick provisioning block.
  - In `apps/roci/src/orchestrator.ts`, add near the existing `provisionWmCli` call (line 185): `import { ensureWmFiles } from "@roci/core/brain/limbic/wm/wm-store.js"` and, inside the eager container-startup block, `yield* ensureWmFiles(char).pipe( … failure-tolerant log … )` mirroring the `provisionWmCli` pattern (log a `wm_files` provision behavior on ready/failed). Use the same `char` in scope at that provisioning site (grep `provisionWmCli(containerId)` context for the local `char`/`containerId` bindings).
  - **Behavior nuance (the one intentional micro-timing change — flag it in the commit):** this shifts wm-file seeding from *first-conscious-turn* to *container startup* — the exact move the `memory` CLI already made (rationale in the `conscious-thought.ts:121-126` comment; no-hot-loading-core-infra rule). `ensureWmFiles` is **idempotent** (never clobbers an existing wm.json/WM.md — see `wm-store.test.ts`), and startup precedes the first tick on all paths, so the seed still exists before any `WM.md`-dependent session request. Net behavior for the running loop is unchanged.

- [ ] **Step 5 — typecheck:** `pnpm exec nx run-many -t typecheck --skip-nx-cache` → green (covers `apps/roci`).
- [ ] **Step 6 — tests:** `pnpm exec vitest --run packages/core/src/brain/cortex/conscious/ packages/core/src/brain/transport/` → green.
- [ ] **Step 7 — GREP-GUARD (now memory AND wm):** run the GREP-GUARD command → expect `CLEAN: no cortex->limbic (memory or wm) edge`. This must now include the wm modules — with Step 4b done, `grep -rnE "wm-store|wm-core|limbic/wm" packages/core/src/brain/cortex/` returns ZERO hits.
- [ ] **Step 8 — commit:**
```
git -C <root> add -A && git -C <root> commit --no-verify -m "refactor(brain): cortex/conscious executor + session-runner split; sever wm edge

session-runner.ts is a code split out of process-runner.ts (fresh blame).
conscious-thought no longer imports wm host code: ensureWmFiles lifted to
apps/roci orchestrator startup, adjacent to the wm-CLI provisioning (memory-CLI
precedent). One intentional micro-timing change: wm-file seeding now at
container startup, not first conscious turn (idempotent; precedes tick 1).
Grep-guard extended to wm: no cortex->limbic edge remains."
```

---

## Task 9: `brain/loop` skeleton — move `state.ts` + `parse.ts` (before the tiers split)

**Decision (state/parse-vs-tiers ordering):** move the shared appraisal/parse helpers to `brain/loop/` NOW, before splitting `tiers.ts`. Reason: `state.ts` is widely imported (loop, tiers, `domain-bundle`, `template-domain`, barrel) and `parse.ts` feeds `tiers.ts`; moving them first means the Task-10 tiers split and the Task-11 loop move both import from the FINAL `brain/loop/` path — avoiding a double-repoint. `brain/loop/` temporarily holds only state+parse; `loop.ts` joins in Task 11.

**Files:**
- Move: `cortex/state.ts` (+ `state.test.ts`, `tier-outcome.test.ts` if it targets state) → `packages/core/src/brain/loop/state.ts`
- Move: `cortex/parse.ts` (+ `parse.test.ts`) → `packages/core/src/brain/loop/parse.ts`

**Interfaces — Consumes / Produces:** `state.ts` exports `freshCortexState`, `appraise`, `appraiseTick`, `emptyEscalation`, `DEFAULT_APPRAISAL_THRESHOLDS`, `shouldForceOrient`, `planSteps`, `decideSteps`, `discoverToPlan`, `isWedgedEmptyPlan`, `isWellFormedDiscover`, `formatStepTask`, `formatExecutionReport`, `formatSteerDirective`, `detectCompletion`, `sanitizeDecideSkill`, `STEP_DONE_MARKER`, and types `CortexState`, `HindbrainEscalation`, `EscalationRung`, `AppraisalThresholds`. `parse.ts` exports `extractJson`, `parseOr`, `tryParseJson`, `isPlainObject`. Cross-dir importers (grep-verified): state ← `core/domain-bundle.ts`, `cortex/loop.ts`, `cortex/tiers.ts`, `index.ts`, `template-domain/bundle.ts`, `template-domain/index.ts`; parse ← `cortex/tiers.ts`.

- [ ] **Step 1 — git mv** state.ts + parse.ts (+ tests) into `brain/loop/`.
- [ ] **Step 2 — re-depth internal imports** in state.ts/parse.ts (were `cortex/` depth-1, now `brain/loop/` depth-2): grep `from "../` and fix (e.g. `from "../skills/types.js"` → `from "../../skills/types.js"`, `from "../core/types.js"` → `from "../../core/types.js"`).
- [ ] **Step 3 — repoint cross-dir importers:**
  - `cortex/loop.ts`: `from "./state.js"` → `from "../brain/loop/state.js"`
  - `cortex/tiers.ts`: `from "./state.js"` → `from "../brain/loop/state.js"`; `from "./parse.js"` → `from "../brain/loop/parse.js"`
  - `core/domain-bundle.ts`: `from "../cortex/state.js"` → `from "../brain/loop/state.js"`
  - `template-domain/bundle.ts`, `template-domain/index.ts`: `from "../cortex/state.js"` → `from "../brain/loop/state.js"`
  - `index.ts` (barrel): lines 79-80 `from "./cortex/state.js"` → `from "./brain/loop/state.js"`
- [ ] **Step 4 — typecheck:** `pnpm exec nx run-many -t typecheck --skip-nx-cache` → green.
- [ ] **Step 5 — tests:** `pnpm exec vitest --run packages/core/src/brain/loop/` → green.
- [ ] **Step 6 — commit:**
```
git -C <root> add -A && git -C <root> commit --no-verify -m "refactor(brain): move cortex state/parse helpers to brain/loop"
```

---

## Task 10: Split `tiers.ts` + re-home OODA prompts

Genuine split (weaker blame on the extracted files). observe/orient runners → a limbic runner home; decide/evaluate/diary runners → cortex/conscious. Prompts follow their runners.

**Files:**
- Create: `packages/core/src/brain/limbic/tiers-limbic.ts` (holds `runHindbrain`, `runForebrain`) — limbic-tier runners.
- Create: `packages/core/src/brain/cortex/conscious/tiers-conscious.ts` (holds `runConsciousDecide`, `runConsciousEvaluate`, `runDiaryTurn`).
- Keep shared `CortexRunnerConfig`, `EvaluateInput`, and the `re-export { extractJson, parseOr }` in whichever file both need — put shared types in `brain/limbic/tiers-limbic.ts` and import them into `tiers-conscious.ts`, OR (cleaner) a tiny `brain/loop/tier-config.ts` for `CortexRunnerConfig`. **Decision:** put `CortexRunnerConfig` in `brain/loop/tier-config.ts` (loop-owned, imported by both runner files — no limbic↔cortex edge).
- Delete: `cortex/tiers.ts`. Move `cortex/tiers.test.ts` → split its cases across the two new homes (or keep one `tiers.test.ts` next to whichever runner it exercises; simplest: `brain/limbic/tiers-limbic.test.ts` + `brain/cortex/conscious/tiers-conscious.test.ts`).
- Move prompts: `skills/observe.md`, `skills/orient.md` → `packages/core/src/brain/limbic/prompts/`; `skills/decide.md`, `skills/evaluate.md`, `skills/diary.md` → `packages/core/src/brain/cortex/conscious/prompts/`.

**Interfaces — Consumes / Produces:** `tiers-limbic.ts` produces `runHindbrain`, `runForebrain`; `tiers-conscious.ts` produces `runConsciousDecide`, `runConsciousEvaluate`, `runDiaryTurn`. Both consume `CortexRunnerConfig` from `brain/loop/tier-config.ts`, `resolveHandle` from `model/handles.js`, `state.js`/`parse.js` from `brain/loop/`, and `loadSkillSync` from `skills/loader.js`. Importers of `cortex/tiers.ts` today: `cortex/loop.ts` (imports all five runners + `CortexRunnerConfig`) and `index.ts` (re-exports `runHindbrain`, `runForebrain`, `runConsciousDecide`, `runConsciousEvaluate`, `CortexRunnerConfig`).

- [ ] **Step 1 — create `brain/loop/tier-config.ts`** exporting `CortexRunnerConfig` (cut from `tiers.ts`).
- [ ] **Step 2 — create `brain/limbic/tiers-limbic.ts`** with `runHindbrain` + `runForebrain` (and their `skills` loads for `observe`/`orient`), importing `SKILLS_DIR = path.resolve(import.meta.dirname, "prompts")` and `CortexRunnerConfig` from `../loop/tier-config.js`, state/parse from `../loop/`.
- [ ] **Step 3 — create `brain/cortex/conscious/tiers-conscious.ts`** with `runConsciousDecide` + `runConsciousEvaluate` + `runDiaryTurn` (loading `decide`/`evaluate`/`diary` from local `prompts/`), importing `CortexRunnerConfig` from `../../loop/tier-config.js`, state/parse from `../../loop/`.
- [ ] **Step 4 — git mv the 5 prompt files** to the two `prompts/` dirs; delete `cortex/tiers.ts`; move/split `tiers.test.ts`.
- [ ] **Step 5 — repoint importers:**
  - `cortex/loop.ts`: replace `from "./tiers.js"` with two imports — `import { runHindbrain, runForebrain } from "../brain/limbic/tiers-limbic.js"` and `import { runConsciousDecide, runConsciousEvaluate, runDiaryTurn, type CortexRunnerConfig } from "../brain/cortex/conscious/tiers-conscious.js"` (or `CortexRunnerConfig` from `../brain/loop/tier-config.js`). Match to where each symbol now lives.
  - `index.ts` (barrel): split line 84-85 — `runHindbrain, runForebrain` `from "./brain/limbic/tiers-limbic.js"`; `runConsciousDecide, runConsciousEvaluate` `from "./brain/cortex/conscious/tiers-conscious.js"`; `CortexRunnerConfig` `from "./brain/loop/tier-config.js"`.
- [ ] **Step 6 — typecheck:** `pnpm exec nx run-many -t typecheck --skip-nx-cache` → green.
- [ ] **Step 7 — tests:** `pnpm exec vitest --run packages/core/src/brain/limbic/tiers-limbic.test.ts packages/core/src/brain/cortex/conscious/tiers-conscious.test.ts` → green.
- [ ] **Step 8 — GREP-GUARD** → CLEAN. **Commit:**
```
git -C <root> add -A && git -C <root> commit --no-verify -m "refactor(brain): split tiers into limbic + conscious runners; re-home OODA prompts

tiers-limbic.ts / tiers-conscious.ts are code splits (fresh blame)."
```

---

## Task 11: `brain/loop` + the Limbic/Cortex facade rewire (the one substantive wiring task)

Move `loop.ts` into `brain/loop/`, repoint the cross-PACKAGE public path, then define the two layer facades and switch the loop from resolving individual tags to resolving the facades. Give the facade rewire careful sub-steps and verify the forked `runDeliberation`/`applyDeliberation` composition still resolves.

**Files:**
- Move: `cortex/loop.ts` → `packages/core/src/brain/loop/loop.ts`; `cortex/loop.test.ts`, `cortex/memory-recall-prompt.test.ts` → `brain/loop/`.
- Create: `packages/core/src/brain/limbic/index-facade.ts` (or extend `brain/limbic/index.ts`) — the **Limbic** facade: a service that composes `EventProcessorTag`, `SituationClassifierTag`, `InterruptRegistryTag` and exposes one interface (`Limbic`) with the methods the loop needs (`processEvent`, `summarize`, `criticals`). Provide `LimbicLive` layer.
- Create: `packages/core/src/brain/cortex/index-facade.ts` — the **Cortex** facade: composes the conscious executor (`ConsciousThought`) + the conscious-tier runners and exposes one interface (`Cortex`) upward. Provide `CortexLive` layer.
- Modify: `packages/core/src/index.ts` — line 77-78 `runCortex`/`CortexLoopConfig`/`CortexResult` `from "./cortex/loop.js"` → `from "./brain/loop/loop.js"`.
- Modify (cross-package): `packages/domain-spacemolt/src/phases.ts:9` and `packages/domain-github/src/phases.ts:12` — `from "@roci/core/cortex/loop.js"` → `from "@roci/core/brain/loop/loop.js"`.
- Delete: the now-empty `cortex/` directory.

**Interfaces — Consumes / Produces:** `Limbic` facade exposes `{ processEvent, summarize, criticals }` (delegating to the three tags it composes). `Cortex` facade exposes the decide/evaluate/executor surface the loop uses. The loop's `runDeliberation` closure composes `readIdentityContext` (limbic/hippocampus) → `runForebrain` (limbic) → `runConsciousDecide` (cortex) and returns pure `DeliberationResult`; `applyDeliberation` seeds on the loop fiber — this composition is loop-owned and must be preserved verbatim through the facade swap. The loop's Effect requirements list (`R` channel) changes from the three individual tags to `Limbic | Cortex` (+ unchanged `StateRendererTag`, `PromptBuilderTag`, `CharacterFs`, `CharacterLog`, `ModelClient`, `ModelService`, `Docker`, `CommandExecutor`, `OAuthToken`, `MemoryGateway`).

- [ ] **Step 1 — git mv loop.ts + its tests** into `brain/loop/`; re-depth loop.ts internal imports (was `cortex/` depth-1, now `brain/loop/` depth-2): `state.js`/`parse.js` become `./state.js`/`./parse.js` (intra now); all `../core|../services|../logging|../model|../skills` become `../../…`; the Task-1/3/5/6/7/8/10 brain imports (`../brain/…`) become `../…` (e.g. `../brain/limbic/wm/wm-store.js` → `../limbic/wm/wm-store.js`).
- [ ] **Step 2 — typecheck the pure move** (before the facade rewire): `pnpm exec nx run-many -t typecheck --skip-nx-cache` → green. Commit checkpoint optional.
- [ ] **Step 3 — define the Limbic facade** (`brain/limbic/index-facade.ts`): a `Context.Tag` `Limbic` with `{ processEvent, summarize, criticals }`; `LimbicLive` composes the existing `EventProcessorTag`/`SituationClassifierTag`/`InterruptRegistryTag` (constructed from the domain bundle) and implements the three methods by delegating. Keep signatures identical to today's direct calls so the loop body needs no logic change.
- [ ] **Step 4 — define the Cortex facade** (`brain/cortex/index-facade.ts`): a `Context.Tag` `Cortex` exposing the executor + decide/evaluate surface, `CortexLive` composing `ConsciousThought` and the `tiers-conscious` runners.
- [ ] **Step 5 — rewire the loop:** replace `const eventProcessor = yield* EventProcessorTag` / `classifier = yield* SituationClassifierTag` / `interrupts = yield* InterruptRegistryTag` with `const limbic = yield* Limbic` (and a `const cortex = yield* Cortex` if the executor/runners are routed through it), updating call-sites (`eventProcessor.processEvent` → `limbic.processEvent`, etc.). Update the loop's `Effect.Effect<…, …, R>` requirements annotation to `Limbic | Cortex | …`. **Do NOT change `runDeliberation`/`applyDeliberation` internals.**
- [ ] **Step 6 — wire the layers** where the loop is provided (domain bundle / orchestrator `planned-action.ts` / wherever the loop's Effect is `provide`d): supply `LimbicLive` + `CortexLive` instead of the three individual tag layers. Grep for where `EventProcessorTag`/`InterruptRegistryTag` layers are currently provided and swap.
- [ ] **Step 7 — repoint the public path + cross-package importers:**
  - `index.ts`: line 77-78 → `from "./brain/loop/loop.js"`
  - `packages/domain-spacemolt/src/phases.ts`, `packages/domain-github/src/phases.ts`: → `from "@roci/core/brain/loop/loop.js"`
- [ ] **Step 8 — typecheck (whole workspace incl. domains):** `pnpm exec nx run-many -t typecheck --skip-nx-cache` → green.
- [ ] **Step 9 — tests:** `pnpm exec vitest --run packages/core/src/brain/loop/loop.test.ts packages/core/src/brain/cortex/conscious/tiers-conscious.test.ts` → green (confirm the forked-deliberation cases still pass).
- [ ] **Step 10 — GREP-GUARD** → CLEAN. **Commit:**
```
git -C <root> add -A && git -C <root> commit --no-verify -m "refactor(brain): move loop to brain/loop; resolve Limbic/Cortex facades

The loop now resolves two layer facades instead of three individual tags;
orient->decide handoff (forked runDeliberation/applyDeliberation) unchanged.
Cross-package runCortex path -> @roci/core/brain/loop/loop.js."
```

---

## Task 12: Docs

**Files:**
- Rewrite: `docs/CORTEX.md` — redefine "cortex" as the conscious/deliberative layer only; the engine is `brain/loop`. **Highest-risk rename** — reconcile every "the cortex loop" phrasing repo-wide (grep `-rn "cortex loop"` and `"cortex/loop.js"` across `docs/`, `packages/*/src/*.md`).
- Move + fix: `core/limbic/LIMBIC.md` → `packages/core/src/brain/limbic/LIMBIC.md`, correcting the three staleness bugs (per spec §6.4): (a) directory-structure block still lists deleted `consolidate.ts` and calls dream "the cull" → "dream = consolidate + cull"; (b) hippocampus "**working-memory** tier" → "**episodic / narrative** memory"; (c) the "long-term memory is a separate tier" note → hippocampus-owned at `brain/limbic/hippocampus/memory/` (still reached in-container via the `memory` CLI). Update the `loop.ts:9-11` back-references to the facade wiring.
- Create: `packages/core/src/brain/BRAIN.md` — the conductor (`brain/loop`) + two layers (limbic/cortex) + shared `brain/transport`, and the reflexive→integrative→deliberative depth model.
- Update: `HARNESS.md` — architecture prose + path references to `brain/`; the two domain docs (`packages/domain-spacemolt/src/SPACEMOLT.md:7`, `packages/domain-github/src/GITHUB.md:7`) that cite `@roci/core/cortex/loop.js` → `@roci/core/brain/loop/loop.js`.

- [ ] **Step 1** — rewrite `docs/CORTEX.md`; **Step 2** — `git mv` + fix `LIMBIC.md`; **Step 3** — write `brain/BRAIN.md`; **Step 4** — update `HARNESS.md` + domain docs; **Step 5** — grep repo-wide for stale `cortex/loop.js` / "cortex loop" and reconcile.
- [ ] **Step 6 — commit:**
```
git -C <root> add -A && git -C <root> commit --no-verify -m "docs(brain): redefine cortex, relocate+fix LIMBIC.md, add BRAIN.md, update HARNESS + domain docs"
```

---

## Task 13: Final verification

No new code — a gate.

- [ ] **Step 1 — full typecheck:** `pnpm exec nx run-many -t typecheck --skip-nx-cache` → green across `@roci/core` + both domain packages + `apps/roci`.
- [ ] **Step 2 — full test suite:** `pnpm exec vitest --run` → all green.
- [ ] **Step 3 — GREP-GUARD (memory AND wm):** run the combined guard → `CLEAN: no cortex->limbic (memory or wm) edge`. The `packages/core/src/brain/cortex/**` scan must return ZERO hits for BOTH the memory host modules (`memory-*`, `longterm-store`, `hippocampus/memory`) AND the wm host modules (`wm-store`, `wm-core`, `limbic/wm`).
- [ ] **Step 4 — structure sanity:** confirm `packages/core/src/cortex/`, `packages/core/src/core/limbic/hypothalamus/`, and the moved `conscious/` files no longer exist; `packages/core/src/brain/{loop,transport,limbic,cortex}/` are populated as designed. Confirm `apps/roci/src/orchestrator.ts` now provisions `ensureWmFiles` at startup and `conscious-thought.ts` imports no wm host code.
- [ ] **Step 5 — MANUAL / EXTERNAL end-to-end gate (not automated):** a roci-qa smoke run confirming the loop still ticks orient→decide→step→evaluate against a real container, **including a forked idle deliberation landing a plan** (the `4a76121` path survived the re-home). Mark done only after the operator confirms — this requires a live model server + Docker and is out of scope for CI here.

---

## Self-review

**1. Spec coverage — every §6 migration-map row and §5 delta maps to a task:**
- §6.1 limbic subdirs → Tasks 5 (hippocampus), 6 (thalamus/amygdala), 7 (autonomic). ✅
- §6.2 hypothalamus 3-way split (transport / session-executor / autonomic) → Tasks 1, 8, 7. ✅
- §6.3 cortex engine + tiers + skills + wm + growth + memory → Tasks 3 (memory), 4 (wm), 5 (growth/identity), 8 (executor), 9 (state/parse), 10 (tiers/prompts), 11 (loop/facades). ✅ install-cli neutral home → Task 2. ✅
- §6.4 docs (CORTEX.md, LIMBIC.md, BRAIN.md, HARNESS.md) → Task 12. ✅
- §5.3a memory cluster / §5.5 integrated commits (fork, SYNTHESIS, wm prune, dream gate) → the fork is preserved verbatim in Task 11; SYNTHESIS producers/injector ride Task 5; wm-prune/dream-gate are internal to files moved in Tasks 4/5 — no extra task needed. ✅
- **Gap found + fixed:** the spec's migration map did not enumerate the **`packages/core/src/index.ts` barrel** re-exports, the **cross-package `@roci/core/cortex/loop.js` public path** (domain phases), the **`core/limbic/index.ts` limbic barrel**, or the **`apps/roci/src/orchestrator.ts` deep-path imports** (`memory-cli`, `memory-embed`, `wm-cli`, `opencode-config`) — all load-bearing across-package edges that break when those files move. Added explicit repoint steps: barrel in Tasks 5/7/8/9/10, barrel relocation in Task 6, public path + domain phases in Task 11, and the orchestrator deep-path repoints in Tasks 3/4/8.
- **Cortex→limbic(wm) edge — RESOLVED this pass (design ruling), not deferred.** The executor's `ensureWmFiles` import is severed in Task 8 by lifting the call up to `apps/roci/src/orchestrator.ts` (adjacent to the existing `provisionWmCli`; caller-above edge, memory-CLI precedent). The grep-guard is extended to wm (Global Constraints + Tasks 8/13). One intentional micro-timing change (wm seeding at startup vs first turn) is flagged; it is behavior-neutral because `ensureWmFiles` is idempotent and startup precedes tick 1.

**2. Placeholder scan:** no "update imports as needed" / "TBD" / "similar to Task N" — every repoint shows the actual `old → new` path. The one deliberately deferred detail (exact new relative depth inside a few multi-import moved files) is handled by a concrete grep-and-re-depth instruction, not a hand-wave.

**3. Type/name consistency:** `session-runner.ts` exports (`runOpenCodeSessionTurn`, `firstSessionId`, `sessionNotFoundMessage`) match Task 1's process-runner export list and Task 8's consumer (`conscious-thought.ts`). `CortexRunnerConfig` is established in Task 10 (`brain/loop/tier-config.ts`) and consumed by both runner files + the loop + barrel consistently. `runHindbrain`/`runForebrain` (limbic) vs `runConsciousDecide`/`runConsciousEvaluate`/`runDiaryTurn` (cortex) split matches the spec §6.3 rows and the barrel repoint. `ensureWmFiles` (Task 4 `wm-store.ts` export) is the exact symbol Task 8 deletes from `conscious-thought.ts` and re-provisions in `apps/roci/src/orchestrator.ts`. `Limbic`/`Cortex` facade method names (`processEvent`/`summarize`/`criticals`) match the loop call-sites they replace.
