# Docs-accuracy revision plan (Mission 1) — verify-every-reference findings + new-subsystem authoring outline

**Date:** 2026-06-30
**Branch audited:** `worktree-docs-and-such`, HEAD `1e84275` (re-verified against THIS tree —
the kickoff handoff was grounded in `worktree-dream-sequence` @ `9ddcff4`, a different
checkout, so every claim below was re-opened here).
**Author role:** Mission 1 docs-accuracy team lead.
**Status:** DESIGN ONLY. No documentation file was edited in producing this plan. This
document is the single deliverable; implementation happens later, by separate agents,
after human approval. This is a hard gate (`superpowers:brainstorming` discipline applies
to the authoring half, Section B).

This plan is grounded in a real audit: every "stale" and every "live replacement" below
was confirmed by opening the target file. Two focused verification subagents covered the
downstream docs (DOMAIN_GUIDE / SPACEMOLT / GITHUB; and cortex-smoke / MODEL_CONFIG /
README / CLAUDE / OPERATING_SKILLS); the team lead personally verified HARNESS.md,
LIMBIC.md, the engine rename, and all four new subsystems. Anything not confirmed is
marked **UNCONFIRMED**.

---

## The two hard guardrails (stated back, per brief)

1. **LIVING references get fixed; DATED records are NEVER touched.**
   - **LIVING — in scope for the verify pass (10 docs):** `HARNESS.md`, `README.md`,
     project `CLAUDE.md`, `docs/DOMAIN_GUIDE.md`, `docs/MODEL_CONFIG.md`,
     `docs/OPERATING_SKILLS.md`, `docs/cortex-smoke.md`,
     `packages/core/src/core/limbic/LIMBIC.md`,
     `packages/domain-spacemolt/src/SPACEMOLT.md`, `packages/domain-github/src/GITHUB.md`.
   - **LIVING but OUT OF SCOPE (external/domain, no in-repo symbols):** `api.md`,
     `docs/onboarding.md`, `character-creation.md`. Do not touch in this mission.
   - **DATED — DO NOT EDIT under any circumstances:** everything under
     `docs/analysis/**`, `docs/superpowers/specs/**` (this plan is the sole new file
     added there), `docs/superpowers/plans/**`, `docs/superpowers/2026-06-20-phases-0-4-*`,
     and `.claude/skills/roci-qa/CALIBRATION.md`. Their line/model drift is intentional
     historical record; "fixing" them destroys evidence.
2. **Even the LIVING docs are NOT edited in this phase.** The output is this plan only.

---

## Verified ground truth (the facts every fix and every new section cites)

| Fact | Proof (file:line) |
|---|---|
| The engine is `runCortex` | `packages/core/src/cortex/loop.ts:104` (exported); re-exported `packages/core/src/index.ts:82` |
| `runChannelSession` returns **zero** grep hits in `packages/` | confirmed; symbol gone |
| `channel-session.ts` / `session-runner.ts` / `cycle-runner.ts` are **not tracked** in git | confirmed (`git ls-files`) |
| Domains call the engine in their `active` phase | `packages/domain-spacemolt/src/phases.ts:170`, `packages/domain-github/src/phases.ts:241` (both `runCortex` from `@roci/core/cortex/loop.js`) |
| The `orchestrator/` dir **survives** (only the two files above were deleted) | `index.ts`, `lifecycle.ts`, `planned-action.ts`, `planning/` still present; `runReflection`/`runBreak` live in `planned-action.ts:36` |
| Cortex tiers + real model ids | `model/handles.ts:54-130` — hindbrain `mlx-community/Qwen3.5-2B-4bit` @ `:8081`; forebrain `mlx-community/Qwen3.5-9B-4bit` @ `:8082`; conscious `mlx-community/gemma-4-31b-it-8bit` @ `:8083` |
| Drives system | `core/drives.ts` (`TEMPLATE_DRIVES`, `CORE_DRIVE_NAMES`, `DomainDrive`, `renderDriveLines`, `parseDriveNames`) |
| Escalation/appraisal | `cortex/state.ts:33-182` (`HindbrainEscalation`, `EscalationRung`, `appraise`, `appraiseTick`, `DEFAULT_APPRAISAL_THRESHOLDS`); seam on `CortexState.escalation` (`state.ts:18`) |
| Long-term memory | `conscious/longterm-store.ts` (`LongtermStore`/`LongtermStoreLive`), `conscious/memory-cli.ts` (`memory` CLI, `MEMORY_CLI_PATH=/usr/local/bin/memory`, `VEC_EXTENSION_PATH=/usr/local/lib/vec0.so`), `conscious/memory-sql.ts` (`EMBED_DIM=384`), `apps/roci/src/embed-server.ts` (host server, port 8084, `mlx-community/bge-small-en-v1.5-bf16`) |
| `frontier` delegation tool | `conscious/frontier-cli.ts` (`FRONTIER_CLI_PATH=/usr/local/bin/frontier`); provisioned by `ConsciousThought.provision` (`conscious/conscious-thought.ts:106`) |
| `DIARY_TARGET_LINES = 150` (the cull target) | `core/limbic/hippocampus/dream.ts:16` |
| `formatStateBar(metrics): string` (NOT `logStateBar`) | `core/state-renderer.ts:17` |
| Live `resolveModel` roles are only `dreamCompression` + `dinner` | `dream.ts:82`, `consolidate.ts:63`; `timeoutSummary` call (`timeout-summarizer.ts:50`) is inside dead `summarizeTimeout` |
| `summarizeTimeout` is dead | `core/limbic/hypothalamus/timeout-summarizer.ts:15` — the only occurrence; zero callers, not re-exported (confirms the handoff's bonus item) |
| `ooda-runner.ts` does **not exist** anywhere | `find` returns nothing (refutes HARNESS.md:285 and OPERATING_SKILLS.md:281) |

---

## A. Verify-every-reference findings (per LIVING doc)

Severity = how broken; Fix-size = effort. "(beyond handoff)" marks drift the kickoff
handoff's §1b sample did not list. "(handoff wrong)" marks where the handoff is inaccurate
against THIS tree.

### A1. `HARNESS.md` — **Large rewrite** (mental-model doc; highest blast radius)

| Loc | Stale text | Verified live replacement (proof) |
|---|---|---|
| `:3` | "spawn a persistent channel session" | engine is the cortex tick loop (`cortex/loop.ts:104`) |
| `:23` | architecture diagram bottoms out at `runChannelSession()` → `channel-session.ts` | `runCortex` (`cortex/loop.ts:104`), invoked from domain `phases.ts` `active` |
| `:26-56` "Channel Session Model" + Lifecycle + Key constants | whole section describes the deleted persistent-`claude --channels` pipeline; `TICK_INTERVAL_MS`/`DEFAULT_SESSION_TIMEOUT_MS`/`POST_SPAWN_DELAY_MS` table | replace with the cortex tick loop: drain→classify→criticals→hindbrain-appraise→forebrain→conscious decide/step/evaluate→sleep. Real constants: `DEFAULT_TICK_MS=30_000` (`loop.ts:72`), `DEFAULT_ORIENT_INTERVAL=5` (`:73`), `DEFAULT_WORKER_TIMEOUT_MS=60*60*1000` (`:77`), `DEFAULT_STEER_CADENCE_TICKS=3` (`:84`) |
| `:62-68` limbic dir tree | lists only thalamus/amygdala/hypothalamus/hippocampus | accurate as far as it goes, but omits the engine dirs (see below) |
| `:70-91` Data-flow diagram | ends at "push channel event to running session" | rewrite to the cortex flow (hindbrain per-event appraisal → `HindbrainEscalation` → forebrain orient → conscious decide → step execution via `ConsciousThought.turn`) |
| `:107` PromptBuilder "taskPrompt/channelEvent are deprecated fallbacks (OODA chain now produces session content)" | partly stale framing | systemPrompt is live (`loop.ts:191`); reword around the cortex loop |
| `:119,:123,:136-137` SpaceMolt/GitHub phase lifecycle "`runChannelSession`" | `runCortex` (`phases.ts:170` / `:241`) |
| `:125` "compress diary if over **200 lines**" | **150** — `DIARY_TARGET_LINES` (`dream.ts:16`). (beyond handoff) |
| `:164-191` "Session Execution Detail" ASCII diagram | the `docker exec claude --channels` + POST /event pipeline | delete/replace — no channel server, no HTTP event POST; events arrive on an Effect `Queue` (`loop.ts:58`), body runs as OpenCode session turns (`conscious-thought.ts`) |
| `:274` `src/core/orchestrator/channel-session.ts` "the primary execution engine" | **file deleted** → `src/cortex/loop.ts` |
| `:275` `src/core/limbic/hypothalamus/session-runner.ts` → `runSession()`/`SessionHandle` | **file deleted** → the hypothalamus now holds `transport.ts`, `payload.ts`, `sdk-payload.ts`, `process-runner.ts`, `runtime.ts`, `tempo.ts`, `types.ts` |
| `:284` `src/core/prompt-builder.ts` "taskPrompt/channelEvent deprecated" | verify wording vs interface |
| `:285` `src/core/ooda-runner.ts` | **file does not exist anywhere** (beyond handoff — handoff cited the cortex dir omission but not this dead Key-Files row). OODA is wired in `cortex/loop.ts` via `runHindbrain`/`runForebrain`/`runConsciousDecide`/`runConsciousEvaluate` (`cortex/tiers.ts`) |
| `:288` `src/core/model-config.ts` "Tier-based model resolution" | still exists but is the LEGACY system; the live cortex topology lives in `model/handles.ts` + `services/model-tier-spec.ts` — Key-Files omits both |
| Key-Files **omissions** | the live engine dirs `src/cortex/`, `src/conscious/`, `src/model/` and the surviving `src/core/orchestrator/{index,lifecycle,planned-action}.ts` (`runReflection`/`runBreak`) are entirely absent | add rows |
| `:295,:310` phase-registry rows "active (runChannelSession)" | `runCortex` |
| 6-service domain table (`:101-108`) | **accurate** — keep |
| Volume mounts / log-files / console-output / commands tables | **accurate** — keep (the `./roci` commands at `:258-266` are real; `roci` script confirmed) |

**Net:** ~6 sections + the Key-Files tables need rewriting; ~3 tables are correct and stay.

### A2. `core/limbic/LIMBIC.md` — **Large rewrite**

| Loc | Stale text | Verified live replacement (proof) |
|---|---|---|
| `:3` | "sits between raw domain events and the **channel session orchestrator**" | reframe: limbic services are consumed by the cortex loop (`cortex/loop.ts` yields `EventProcessorTag`/`SituationClassifierTag`/`InterruptRegistryTag`) |
| `:22` `session-runner.ts` → `runSession()` | **file deleted** |
| `:25-27` `types.ts` "CycleConfig/CycleResult", `cycle-runner.ts` → `runCycle()`, `timeout-summarizer.ts` | `cycle-runner.ts` **deleted**; the real hypothalamus files are `transport.ts`, `payload.ts`, `sdk-payload.ts`, `process-runner.ts`, `runtime.ts`, `tempo.ts`, `types.ts` (confirmed by dir listing). `timeout-summarizer.ts` exists but is **dead** (`summarizeTimeout`, zero callers) |
| `:110-149` "Hypothalamus — Session Execution" | the whole `runSession`/`SessionHandle`/`SessionResult`/`runCycle`/`runTurn` narrative | the live hypothalamus is the SDK/process transport layer feeding the cortex loop's conscious turns (`process-runner.ts` `runOpenCodeSessionTurn`, used by `conscious-thought.ts:7`). `SessionHandle`/`SessionResult` types as documented are gone |
| `:151-167` Hippocampus | documents only `dream` | add `consolidate.ts` (`consolidate.execute`, the per-cycle diary rewrite; `consolidate.ts`), which ships and runs in `runReflection` before the cull |
| `:169-187` **Barrel File Contract table** | claims hypothalamus exports `runSession`/`runCycle`/`SessionHandle`/`SessionResult`/`CycleConfig`/`CycleResult` | **counterfactual** — `core/limbic/index.ts` hypothalamus row exports ONLY `TempoConfig`/`TempoBase`/`StateMachineTempo`/`PlannedActionTempo` (confirmed by opening `index.ts`). A reader importing per the doc gets a missing-export error. Also `Alert` is exported from `../types.js`, not amygdala |
| Thalamus + Amygdala sections (`:35-108`) | **accurate** (EventProcessor/SituationClassifier/InterruptRule/InterruptRegistry all match) — keep |
| **(handoff wrong)** | handoff §1b said LIMBIC omits "`sdk-runner/`" | there is **no `sdk-runner/` directory** in the tree; the SDK file is `sdk-payload.ts`. Do not author a section for a dir that doesn't exist |

**New content for LIMBIC.md:** the drives/escalation system is the natural fit here (see B2) — `appraise`/`appraiseTick`/`HindbrainEscalation` live in `cortex/state.ts` but are conceptually limbic (the hindbrain appraisal), and `core/drives.ts` is the drives home.

### A3. `docs/DOMAIN_GUIDE.md` — **Medium–Large**

| Loc | Stale text | Verified live replacement (proof) |
|---|---|---|
| `:143,:165,:344,:414` | `StateRenderer.logStateBar(name, metrics): void` | **`formatStateBar(metrics): string`** (`state-renderer.ts:17`; impls `spacemolt/renderer.ts`, `github/renderer.ts`). (beyond handoff) |
| `:226,:229,:264,:418` | "Configure OODA behavior when calling `runChannelSession`" / "active calls `runChannelSession()`" | `runCortex` (`cortex/loop.ts:104`) |
| `:268` | `import { runChannelSession } from "@roci/core/core/orchestrator/channel-session.js"` | `import { runCortex } from "@roci/core/cortex/loop.js"` |
| `:226-235, :278-296` code examples | pass `sessionModel: "sonnet"` and `dream: { cycleInterval, maxIntervalTicks }` | **neither field exists** on `CortexLoopConfig` (`loop.ts:53-66`: `char`, `containerId`, `containerEnv`, `addDirs`, `events`, `initialState`, `cadence`, `cortexModels`, `workerModels`, `orientInterval`, `workerTimeoutMs`, `tickIntervalMs`). Real calls: `phases.ts:170-176`/`:236-245`. Full example rewrite. (beyond handoff) |
| `:301` | "Dream … triggers automatically based on `dream` config" | dream/cull runs in the reflection phase via `runReflection` (`planned-action.ts:36`), not a `CortexLoopConfig` field |
| `:386` | `SituationClassifier` → `packages/domain-spacemolt/src/situation.ts` | **CORRECT** — `situation.ts` exists (alongside `situation-classifier.ts`). (handoff said correct; confirmed — keep) |
| `:424` | build cmd `pnpm check && pnpm lint` | scripts exist (`package.json`: `check`=`biome check .`, `lint`=`biome lint .`); pre-commit builds the full tree via `nx run-many -t build`. Low-priority; verify the `pnpm` vs runner convention at fix time (UNCONFIRMED which the project prefers) |
| No cortex/drives/memory mention | — | add a short "engine = cortex loop" pointer to HARNESS/LIMBIC |

### A4. `docs/cortex-smoke.md` — **Medium** (mechanical model-name fixes; will FAIL if followed verbatim)

| Loc | Stale text | Verified live replacement (proof) |
|---|---|---|
| `:18` | hindbrain `mlx-community/Qwen3.5-9B-4bit` | `mlx-community/Qwen3.5-2B-4bit` (`handles.ts:94`) |
| `:19` | forebrain `mlx-community/GLM-4.7-Flash-4bit` (does not exist in code) | `mlx-community/Qwen3.5-9B-4bit` (`handles.ts:112`) |
| `:20` | conscious `mlx-community/Qwen3.5-122B-A10B-4bit` | `mlx-community/gemma-4-31b-it-8bit` (`handles.ts:127`) |
| `:28,:31,:34` | `mlx_lm.server` start commands repeat the same three wrong models | same three replacements |
| `:72,:77,:82` | `ROCI_MODEL_SMOKE_MODEL=…` vitest invocations repeat the wrong three | same three replacements |
| `:101,:107` | "100 passed, 2 skipped" | stale; the live count must be **re-derived at fix time** (`vitest --run`), not hard-coded. Handoff said 626/4; a fresh subagent run reported 297 passed with 37 failed files (env/build issue, not authoritative). **UNCONFIRMED exact number** — re-run before writing it |
| frontier + SDK-runner + `client.smoke.test.ts` (`:73,:78,:83,:249,:364-392,:483`) | references to `frontier-cli.ts`, `process-runner.ts`, `client.smoke.test.ts` | **all exist & correct** — keep. Add a pointer to the sibling `memory` CLI (new — `memory-cli.ts`) |

### A5. `docs/MODEL_CONFIG.md` — **Medium**

| Loc | Stale text | Verified live replacement (proof) |
|---|---|---|
| `:22-24` | documents roles `brainPlan`/`brainInterrupt`/`brainEvaluate` | **dead** — zero `resolveModel` call sites (only in the `Role` union `model-config.ts:11-13` + tests). Live roles are **`dreamCompression`** (`dream.ts:82`) and **`dinner`** (`consolidate.ts:63`) only |
| (beyond handoff) | — | the dead surface is **larger** than the three `brain*` roles: the `Role` union (`model-config.ts:10-22`) also includes `diarySubagent`, `timeoutSummary` (live-looking but inside dead `summarizeTimeout`), `scaffoldIdentity`, `scaffoldSummary`, `oodaObserve/Orient/Decide/Evaluate` — none have live `resolveModel` callers. The doc should describe only the genuinely-live roles and clearly mark the rest |
| whole doc | documents only the legacy `fast`/`smart`/`reasoning` tier system | **omits the live cortex MLX tier topology** entirely — `model/handles.ts:54-130` (`DEFAULT_CORTEX_MODELS`) + `services/model-tier-spec.ts` (per-tier port/lifecycle). There are effectively two model systems; the doc covers only the older one |

### A6. `README.md` — **Small** (no stale code symbols)

- No stale file/symbol references. `:31` already mentions the cortex/MLX tiers correctly.
- Internal inconsistency only: `:5` "channel session event loop" / `:16` "channel session
  orchestrator" use legacy framing alongside the updated `:31` cortex prose. Omits drives +
  long-term memory. Reconcile the framing and add one line each on drives + memory.
- `pnpm`-flavored commands coexist with HARNESS's `./roci` — both are real; not an error.

### A7. `CLAUDE.md` (project root) — **Small** (no stale code symbols)

- No file/symbol/line references to verify.
- Stale conceptual framing only: "state machine event loop, brain/body execution model";
  domain blurbs "plan/act/evaluate state machine loop" / "planned-action brain/body cycle".
  Per MEMORY: "there is no body — it's the in-game opencode agent." "6 injectable Effect
  service layers" is still accurate for domain services. Reword to the cortex loop; add
  `LongtermStore` + cortex tiers in one sentence.

### A8. `SPACEMOLT.md` — **Medium**

| Loc | Stale text | Verified live replacement (proof) |
|---|---|---|
| `:3,:7,:19,:24` (handoff cites) — subagent confirmed `:7` | "persistent channel session (`runChannelSession` from `core/orchestrator/channel-session.ts`)" | `runCortex` from `@roci/core/cortex/loop.js` (`phases.ts:9`). Sweep all four cited lines at fix time |
| `:99` | "`DIARY_TARGET_LINES` = 150 lines (defined in core's `dream.ts`)" | value 150 is **correct**; path is incomplete → `core/limbic/hippocampus/dream.ts:16`. (beyond handoff) |

### A9. `GITHUB.md` — **Medium** (NB: MEMORY flags domain-github as "rusty / awaiting major revision" — fix refs, don't canonicalize its patterns)

| Loc | Stale text | Verified live replacement (proof) |
|---|---|---|
| `:3,:7,:26` (handoff cites) — subagent confirmed `:7` | "persistent channel session (`runChannelSession` from `core/orchestrator/channel-session.ts`)" | `runCortex` from `@roci/core/cortex/loop.js` (`phases.ts:12`). Sweep all three cited lines |
| `:30,:96` | dream threshold "200 lines" | **150** — `DIARY_TARGET_LINES` (`dream.ts:16`). (beyond handoff) |

### A10. `docs/OPERATING_SKILLS.md` — **Small** (handoff said "None"; it was WRONG)

| Loc | Stale text | Verified live replacement (proof) |
|---|---|---|
| `:281` | "Operating skills are wired into the channel session tick loop via `ooda-runner.ts`" | **`ooda-runner.ts` does not exist.** Wired into `cortex/loop.ts` via `runHindbrain`/`runForebrain`/`runConsciousDecide`/`runConsciousEvaluate` (`cortex/tiers.ts`). The skill templates load via `loadSkillSync` from `src/skills/` (`tiers.ts:27-34`). (handoff said no stale refs — refuted) |
| rest of doc | `src/skills/` OODA templates, loader/renderer | **accurate** — keep |

**Headline counts (Section A):** **~35 distinct stale references across 9 of the 10
in-scope docs** (README has only framing drift; OPERATING_SKILLS has exactly one). **At
least 7 are beyond the handoff's §1b sample:** `formatStateBar` (DOMAIN_GUIDE ×4), the
nonexistent-field `runCortex` examples (DOMAIN_GUIDE), the `ooda-runner.ts` rows
(HARNESS:285 **and** OPERATING_SKILLS:281 — the latter contradicts the handoff's "None"),
the 200→150 diary threshold (HARNESS:125, GITHUB:30/96), the incomplete `dream.ts` path
(SPACEMOLT:99), and the larger-than-three dead-role surface in MODEL_CONFIG.

---

## B. New-subsystem authoring outline (the harder half — authoring, not find-and-replace)

Four shipped subsystems are undocumented at architecture level. For each: the genuine
**structure decision** is surfaced with a recommendation (per `brainstorming` discipline),
then a proposed section outline with code anchors. Write fresh against the code; the dated
specs (`docs/superpowers/specs/2026-06-29-limbic-drives-design.md`,
`…/2026-06-30-longterm-memory-design.md`, `…/2026-06-19-cybernetics-phase4b-…`) are leads,
not copy sources.

### B1. The cortex tier loop — the engine

**Where to host it — options:**
- **(B1-i) One big HARNESS.md rewrite** that replaces the "Channel Session Model" section
  wholesale with a "Cortex Loop" section. Pro: HARNESS is the mental-model doc and readers
  expect the engine there. Con: HARNESS is already large.
- **(B1-ii) A new standalone `docs/CORTEX.md`** + a short HARNESS pointer. Pro: room to
  document the tick anatomy + parse-tolerance design in depth; mirrors LIMBIC.md/OPERATING_
  SKILLS.md as a focused reference. Con: one more doc to keep in sync.
- **(B1-iii) Extend `cortex-smoke.md`** — rejected: that doc is an operational runbook, not
  an architecture reference.

**Recommendation: B1-ii (new `docs/CORTEX.md`) + replace HARNESS's "Channel Session Model"
section with a tight summary that links to it.** The engine is too central and too detailed
(tick anatomy, three tiers, parse tolerance, steering, completion model) to inline cleanly,
and HARNESS already cross-links LIMBIC/OPERATING_SKILLS/MODEL_CONFIG/DOMAIN_GUIDE the same way.

**Proposed CORTEX.md outline + anchors:**
1. *What the loop is* — `runCortex(config)` (`loop.ts:104`), invoked per-character in the
   `active` phase (`phases.ts:170`/`:241`). Events arrive on an Effect `Queue` (`loop.ts:58`).
2. *The three tiers* — hindbrain/forebrain/conscious (`model/handles.ts:1-2,54-130`); each
   tier's job + real model (`tiers.ts`: `runHindbrain`/`runForebrain`/`runConsciousDecide`/
   `runConsciousEvaluate`/`runDiaryTurn`).
3. *The tick anatomy* — the 7 numbered steps in `loop.ts:201-613` (drain→classify+criticals→
   poll in-flight turn→hindbrain appraise→forebrain orient (idle vs in-session)→step
   execute/evaluate→sleep). Constants `loop.ts:72-84`.
4. *Plans, steps, completion* — `STEP_DONE_MARKER` (`state.ts:282`), `detectCompletion`
   (`state.ts:289`), tick-budget salvage (`loop.ts:452-465`), the diary turn (`loop.ts:497`).
5. *Steering* — `formatSteerDirective` (`state.ts:298`), coalescing `pendingDirective` +
   `DEFAULT_STEER_CADENCE_TICKS` (`loop.ts:84,582-606`).
6. *Parse tolerance* — `parse.ts` (`extractJson`/`parseOr`/`tryParseJson`), the
   fallback-merge design (`tiers.ts:155-216`); why structured tiers run thinking-OFF
   (`handles.ts:54-130` comment block).
7. *The conscious executor* — `ConsciousThought` (`conscious-thought.ts:57`), OpenCode
   session turns via `runOpenCodeSessionTurn` (`conscious-thought.ts:7`), provision-once
   (`loop.ts:192`).

### B2. Drives & escalation (the limbic appraisal)

**Where to host it — options:**
- **(B2-i) A new section in LIMBIC.md** ("Hindbrain appraisal & escalation"). Pro: it IS the
  limbic/hindbrain layer conceptually; LIMBIC.md is the right mental home; the drives file
  `core/drives.ts` and the palette are character-template companions. Con: the code physically
  lives in `cortex/state.ts`, not `core/limbic/` — the doc must cite across the boundary.
- **(B2-ii) A section in the new CORTEX.md.** Pro: code locality. Con: splits the limbic
  story across two docs.

**Recommendation: B2-i — author it in LIMBIC.md, cross-referencing `cortex/state.ts`.** The
escalation is the hindbrain's product and belongs with the other limbic regions; note
explicitly that the reducer lives in `cortex/state.ts` for hot-loop locality.

**Proposed outline + anchors:**
1. *Drives* — innate motivators `safety`/`sustenance`/`agency` (`drives.ts:17-22`,
   `CORE_DRIVE_NAMES`), domain drives via `DomainConfig…domainDrives` merged by
   `renderDriveLines` (`drives.ts:36`); the `DRIVES.md` character file (`drivesFile`).
2. *Per-event appraisal* — the 2B hindbrain tags each state-changing event into an
   `ObserveResult`; `appraise` validates/clamps (`state.ts:108`); inert events are
   fast-pathed (`loop.ts:92-99,285-292`).
3. *The escalation ladder* — `EscalationRung` none→accumulate→steer→reorient→interrupt
   (`state.ts:36`), `appraiseTick` reducer (`state.ts:150`), thresholds (`state.ts:53`),
   `HindbrainEscalation` seam on `CortexState.escalation` (`state.ts:18,59-77`).
4. *How the loop consumes it* — idle orient vs in-session steer/reorient/interrupt
   (`loop.ts:293-427`); relationship to the amygdala critical path (which EXITS the loop).

### B3. Long-term memory

**Where to host it — options:**
- **(B3-i) A new standalone `docs/MEMORY.md`.** Pro: it spans host + container + db + embed
  server + promotion hook — substantial, cross-cutting, with its own operational runbook
  needs (the dormancy/`ROCI_EMBED_PYTHON` gotcha, Mission 2 O1). Con: new doc.
- **(B3-ii) A section in LIMBIC.md hippocampus.** Pro: memory consolidation already lives in
  hippocampus. Con: long-term memory is a different tier (append-only vector store, not the
  working-memory diary) and pulls in host-process + container-CLI concerns that don't fit the
  limbic-regions metaphor.

**Recommendation: B3-i — new `docs/MEMORY.md`**, with a one-line pointer from LIMBIC.md
hippocampus ("working memory = diary/cull; long-term = vector store, see MEMORY.md") and
from cortex-smoke.md (the `memory` CLI sibling of `frontier`).

**Proposed outline + anchors:**
1. *The tiers* — working memory (diary + `consolidate`/`dream` cull, `DIARY_TARGET_LINES=150`)
   vs long-term (append-only sqlite-vec store).
2. *The store* — `LongtermStore`/`LongtermStoreLive` (`longterm-store.ts:62,98`); every op
   shells the in-container `memory` CLI over `docker exec` (db Bus-errors on host bun/macOS,
   `longterm-store.ts:9-24`).
3. *The `memory` CLI* — `remember`/`search`/`recent`/`promote`/`mark-get`/`mark-set`
   (`memory-cli.ts:32-51,145-206`); installed at `/usr/local/bin/memory` as root
   (`memory-cli.ts:17,224-235`); baked `vec0.so` (`:19`); bun + `bun:sqlite` + `loadExtension`.
4. *Embeddings* — host server `apps/roci/src/embed-server.ts` (port 8084,
   `mlx-community/bge-small-en-v1.5-bf16`, `EMBED_DIM=384` `memory-sql.ts:20`); reached via
   `host.docker.internal` rewrite (`memory-embed.ts:6`); launched best-effort in `roci start`
   (`cli.ts:132`).
5. *Pre-cull promotion* — `runReflection` promotes raw diary appends before the cull
   (`planned-action.ts:61-119`); the bounded high-water mark design (`longterm-store.ts:26-60`).
6. *Operational note* — the dormancy gotcha: `ROCI_EMBED_PYTHON` defaults to `python3` but
   `mlx-embeddings` lives in `~/llm-env` (`embed-server.ts:39-42`). **This is Mission 2's O1,
   not a docs fix — document the current behavior, flag the runbook need, do not "fix" it here.**

### B4. The `frontier` delegation tool

**Where to host it — options:**
- **(B4-i) A subsection of CORTEX.md** (under the conscious executor). Pro: `frontier` is a
  capability of the conscious tier; provisioned alongside it. Con: —
- **(B4-ii) Its own doc.** Rejected — too small to stand alone; it's already partly covered
  in cortex-smoke.md.

**Recommendation: B4-i — a CORTEX.md subsection**, plus keep/refresh the existing
cortex-smoke.md frontier coverage.

**Proposed outline + anchors:** handle-based async worker (`frontier start/poll/steer/wait`,
`frontier-cli.ts:34-48`), installed at `/usr/local/bin/frontier` (`:6`), state under
`/tmp/frontier-<id>` on the shared container fs; runs a detached `claude` worker on the
reasoning-tier model (`buildFrontierWorkerFlags`, `frontier-cli.ts:18-37`); provisioned by
`ConsciousThought.provision` (`conscious-thought.ts:106`), now **as root** (commit `35cce83`).
The `memory` CLI is its structural sibling (same base64-pipe provisioning pattern).

---

## C. Sequenced execution plan (batched into independent units for fresh agents)

Sequenced by blast radius (handoff §1d): mental-model docs first, then engine-rename
downstream, then mechanical model fixes, then summaries. **Serialization hazards flagged.**

> **Authoring vs. fixing split:** Each unit below mixes verify-pass fixes (Section A) with
> new authoring (Section B). The new standalone docs (CORTEX.md, MEMORY.md) can be drafted in
> parallel by separate agents *if* the human approves creating them (Decision D1) — they touch
> no existing file. Hold them until D1 is resolved.

**Unit 1 — HARNESS.md + new CORTEX.md (Large; the mental model).** Rewrite HARNESS §A1;
author CORTEX.md (§B1) + the `frontier` subsection (§B4). These must be done together (HARNESS
links CORTEX). One agent. *Blocks nothing downstream factually, but everything inherits its
framing — do first.*

**Unit 2 — LIMBIC.md (Large).** Fix §A2 (delete `runSession`/`runCycle` narrative, fix barrel
table, add `consolidate`) + author the drives/escalation section (§B2). One agent. Independent
of Unit 1's file set; can run in parallel with Unit 1.

**Unit 3 — DOMAIN_GUIDE.md + SPACEMOLT.md + GITHUB.md (Medium–Large; engine-rename
downstream).** Fix §A3/A8/A9 (`runChannelSession`→`runCortex`, `formatStateBar`, the
nonexistent-field examples, 200→150, paths). One agent (shared engine-rename context). **Run
AFTER Unit 1** so the `runCortex` framing/anchors are settled (the DOMAIN_GUIDE examples should
match the CORTEX.md description). Three distinct files → can sub-split, but keep one agent for
consistency.

**Unit 4 — cortex-smoke.md + MODEL_CONFIG.md (Medium; mechanical model topology).** Fix §A4
(three model names ×6 sites + re-derived test count) and §A5 (dead roles + add cortex tier
topology). One agent. **Re-run `vitest --run` to get the live test count before writing it.**
Independent of Units 1–3; can run in parallel.

**Unit 5 — new MEMORY.md + the cortex-smoke/LIMBIC pointers (Medium).** Author MEMORY.md
(§B3). Adds a one-line pointer to cortex-smoke.md and LIMBIC.md. **Pointer into cortex-smoke.md
serializes against Unit 4; pointer into LIMBIC.md serializes against Unit 2** — land MEMORY.md's
body first, add the two pointers last (or fold the pointers into Units 2 & 4). Gated on D1.

**Unit 6 — README.md + project CLAUDE.md (Small; summaries).** Fix §A6/A7 framing; add one
line each on drives + long-term memory. **Do LAST** — summaries should reflect the settled
vocabulary from Units 1–5. One agent.

**Same-file serialization map:** No two units edit the same existing file *except* the
MEMORY.md pointers (Unit 5 → Unit 2's LIMBIC.md and Unit 4's cortex-smoke.md). Resolve by
ordering Unit 5's pointer-edits after Units 2 & 4, or by folding those two one-line pointers
into Units 2 & 4 directly (recommended — avoids the cross-unit touch entirely).

**Worktree discipline (carried from handoff):** all edits via `git -C <this worktree>` with
absolute paths *inside this worktree*; `isolation:worktree` subagents fork from repo base —
reconcile on merge. Pre-commit builds the full 4-project tree.

---

## D. Open decisions for the human

1. **D1 — New standalone docs vs. inline.** Recommendation B1-ii + B3-i create two new files:
   `docs/CORTEX.md` and `docs/MEMORY.md`. The alternative is inlining both into HARNESS.md
   (one very large doc). **Decision: approve the two new docs, or inline?** This gates Units 1
   and 5's shape.
2. **D2 — Where the drives/escalation section lives.** Recommendation B2-i puts it in LIMBIC.md
   though the code is in `cortex/state.ts`; B2-ii puts it in CORTEX.md (code-local). **Pick the
   mental-home (LIMBIC) or the code-home (CORTEX).**
3. **D3 — MODEL_CONFIG.md scope: prune vs. mark.** The dead-role surface is larger than the
   handoff's three `brain*` roles (also `diarySubagent`, `scaffold*`, `ooda*`, and effectively
   `timeoutSummary`). **Should the doc just describe the two live roles + cortex tiers (lean),
   or document all roles and mark the dead ones (complete-but-noisy)?** NB: the `Role` *type
   union* (`model-config.ts:10-22`) still exists; this is a docs decision, not a code change.
4. **D4 — `pnpm` vs runner convention** (DOMAIN_GUIDE:424, README commands). The scripts
   (`check`/`lint`/`build`/`test`) exist; whether the canonical invocation is `pnpm …`, `npm
   run …`, or `nx …` is **UNCONFIRMED**. **Confirm the project's preferred command surface** so
   the verify pass writes the right one.
5. **D5 — Dead-code cleanup adjacency (out of docs scope, flag-only).** `summarizeTimeout`
   (`timeout-summarizer.ts:15`) is confirmed dead, and `ooda-runner.ts` is referenced by two
   live docs but doesn't exist. The docs fix removes the references; **does the human also want
   a follow-up code-deletion task** (`tracing-dead-code-after-deletion` discipline) for
   `summarizeTimeout` + the dead `Role` entries? Not part of Mission 1; noted for Mission 2.

---

## Surprises that contradict / extend the handoff

- **OPERATING_SKILLS.md is NOT clean.** Handoff §1b said "No stale in-code refs found";
  `:281` cites the nonexistent `ooda-runner.ts`. Same ghost file is in HARNESS.md:285.
- **DOMAIN_GUIDE.md has deeper drift than a name-swap.** Beyond `runChannelSession`, its
  `runCortex` examples pass fields that don't exist (`sessionModel`, `dream:{…}`) and it uses
  a renamed method (`logStateBar`→`formatStateBar`). These are rewrites, not replacements.
- **The handoff's `sdk-runner/` does not exist.** §1b said LIMBIC.md "omits the real files …
  `sdk-runner/`"; there is no such directory — the SDK file is `sdk-payload.ts`. Don't author a
  section for it.
- **The dead-role surface is wider than the three `brain*` roles** (D3).
- **The diary threshold is 150, not 200** — HARNESS.md:125 and GITHUB.md:30/96 all say 200;
  `DIARY_TARGET_LINES=150`.
- **The `orchestrator/` dir survives.** The handoff is right that `channel-session.ts`/
  `session-runner.ts` are gone, but the dir still holds `runReflection`/`runBreak`
  (`planned-action.ts`) — do not describe the whole orchestrator layer as deleted.
- **Confirmed exactly as the handoff said:** the engine rename, the counterfactual LIMBIC
  barrel table, the three cortex-smoke model names, the dead `summarizeTimeout`, all three
  subteam commit ranges present on this branch, and DOMAIN_GUIDE:386 `situation.ts` being
  *correct*.
