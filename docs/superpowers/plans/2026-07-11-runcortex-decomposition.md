# `runCortex` decomposition — handoff plan

**Goal:** shrink the ~1082-line `runCortex` (`packages/core/src/brain/loop/loop.ts`) into a *thin conductor* — pace, poll, dispatch, and the loop-owned orient→decide fork — by pushing conscious-session lifecycle down into `cortex/`, reflex scheduling into `limbic/`, and wm/episode bookkeeping into its owning subsystems, then rename it.

**Sequence (FIXED):** **B (bug fixes) → A (decomposition) → rename.** The rename is last on purpose: `runCortex` can only get an accurate name (`runArousal` / a reticular-activating-system word) once it stops doing everything inline.

**Audience:** a *fresh* session with no prior context. Everything you need to start is here or cited by `file:line`. This plan is deliberately NOT bite-sized TDD steps for the code — Phase 0 (characterization) produces those. The seam inventory and phase boundaries below are concrete enough to start immediately.

**Grounded against:** HEAD `be6c1988c85d8f769e263d1b3f8d8329b3ea992f` (branch `worktree-historical-reference`). All `file:line` refs are from that tree. Re-grep before editing — a recent `autonomic → hypothalamus` rename (commit `4dd0143`) already shifted some numbers, and each phase you land shifts them again.

---

## 1. Grounded current state (verified)

### Bootstrap → loop
- `apps/roci/src/cli.ts:157` (and `setup/validate-and-start.ts:99`) call `runOrchestrator(resolved, args.tickInterval, models, …)` — `apps/roci/src/orchestrator.ts:85`.
- `runOrchestrator` builds images, ensures one container per domain, eagerly provisions the in-container `memory` CLI (`:171`), `wm` CLI (`:186`), and seeds per-character WM files via `ensureWmFiles` (`:206`) — **wm/memory host provisioning lives in the orchestrator now, not in the loop**. It forks one fiber per character (`Effect.fork`, `orchestrator.ts:310`) and `Fiber.joinAll`s them (`:323`).
- Each fiber runs `runPhases` (`packages/core/src/core/phase-runner.ts:9`) — a `Continue/Restart/Shutdown` state machine over the domain's `PhaseRegistry`.
- `runCortex` is invoked from the **domain `active` phase**, NOT the orchestrator: `domain-spacemolt/src/phases.ts:170`, `domain-github/src/phases.ts:241`. The orchestrator's `tickIntervalSeconds` param is only used for a `session_start` log field (`orchestrator.ts:269`); it is **not** threaded into `runCortex`.

### Queue = push, loop = pull
- The domain forwarding fiber `Queue.offer`s events (spacemolt `game-socket-impl.ts:245-249`); the loop `Queue.poll`-drains them (`loop.ts:546`). Next tick is a fixed `Effect.sleep(\`${tickMs} millis\`)` at the end of a `while (true)` (`loop.ts:532`, `:1063`). `tickMs = config.tickIntervalMs ?? DEFAULT_TICK_MS` (`loop.ts:179`, `DEFAULT_TICK_MS = 30_000` at `:96`).

### Stage → function → layer → hot-path (verified line refs)
| OODA stage | function | layer | where in loop | on hot path? |
|---|---|---|---|---|
| appraise | `runHindbrain` (`limbic/tiers-limbic.ts:36`) | limbic | `loop.ts:636` | **INLINE** (the "finding G" freeze) |
| orient | `runForebrain` (`limbic/tiers-limbic.ts:83`) | limbic | forked in `runDeliberation` (`:358`, fork `:729`); inline on steer (`:788`) | forked (idle) / inline (steer) |
| decide | `runConsciousDecide` (`cortex/conscious/tiers-conscious.ts:47`) | cortex | forked in `runDeliberation` (`:377`) | forked |
| execute | `consciousThought.turn` (`cortex/conscious/conscious-thought.ts:72`) | cortex+transport | forked `consciousFiber` (`:1019`, steer `:1043`) | forked |
| evaluate | `runConsciousEvaluate` + `runDiaryTurn` (`tiers-conscious.ts:116`, `:168`) | cortex | `loop.ts:854`, `:934` | **INLINE** |

- The orient→decide handoff is a **forked, loop-owned** `runDeliberation` (fork `:729`) → `applyDeliberation` (`:687`) over a fork-time `DeliberationContext` snapshot (`:134-139`, captured `:722-727`). The fork reads only the snapshot, never live `cortex.*`, so a slow deliberation appraises a coherent moment while the loop keeps ticking.
- `callTier`/`emitTier` and `CortexRunnerConfig` live in `brain/loop/tier-config.ts` — the shared plumbing both tier-runner files import *down* so neither imports the other.

### The flaw
The layer wall is real at **import** time (Biome `noRestrictedImports`, below) but **collapses at runtime**: the loop directly owns cortex's session lifecycle (`consciousFiber`/`sessionId`/steer cadence — `loop.ts:235-245`, `:604-620`, `:1000-1058`), runs limbic's reflex inline (`:636`), and inlines all wm/episode bookkeeping. Its return type is `CortexResult` (`:92`) and the tests literally call it the **"conscious-session executor"** (`loop.test.ts:262`). It is a conductor that also plays every instrument.

### Real docs (cite; keep consistent)
- `packages/core/src/brain/BRAIN.md` — cognition map, layer directory structure, load-bearing invariants (esp. #1: limbic/cortex never import each other; the loop mediates the seam via the forked deliberation; "the reflexive hindbrain triage still runs inline").
- `docs/CORTEX.md` — §3 tick anatomy (numbered steps mirror the loop), §3 "The orient→decide seam runs as a forked fiber", §4 plans/steps, §5 steering, §7 conscious executor.
- `packages/core/src/brain/limbic/LIMBIC.md` — escalation ladder (§3), the subsystems.
- `HARNESS.md` — top-level architecture.

---

## 2. Seam inventory (the heart of the plan)

For each block of `loop.ts` (HEAD `be6c1988`), the home it belongs to: **[LOOP]** stays (pace/poll/dispatch/seam), **[→CORTEX]** conscious-session lifecycle, **[→LIMBIC]** reflex, **[BOOK]** wm/episode/memory bookkeeping (rehome to owning subsystem or keep loop-side as thread-through).

| lines | block | home |
|---|---|---|
| 151-193 | service `yield*` resolution, config defaults, `runnerConfig` assembly | **[LOOP]** conductor DI |
| 199-207 | `readOrEmpty` (diary read helper) | **[BOOK]** used only by evaluate/diary |
| 209-234 | plan/wm lets (`state`,`cortex`,`tick`,`stepStartTick`,`forceOrientNext`,`planHeadline`,`wornSkill`,`planHeadline/StepTodoId(s)`) | **[LOOP]**+**[BOOK]** loop pacing state + plan bookkeeping |
| 235-245 | **"Conscious-session state"** (`consciousFiber`,`sessionId`,`stepReport`,`stepDoneSignaled`,`pendingDirective`,`lastSteerTick`,`bypassSteerCadence`) | **[→CORTEX]** — explicit target |
| 248-254 | deliberation-fork lets (`deliberationFiber`,`deliberationSnapshotCount`,`deliberationSettledThisTick`) | **[LOOP]** loop-owned seam |
| 260-269 | `emitWmRecord` | **[BOOK]** wm/episode |
| 276-288 | `discardPlanOrphans` | **[BOOK]** wm |
| 295-337 | `resetPlanState` | **[BOOK]** (wm/episode) + resets **[→CORTEX]** session lets — split |
| 346-404 | `runDeliberation` (orient+recall+decide over snapshot) | **[LOOP]** the seam — the ONLY code allowed to touch both layers |
| 411-498 | `applyDeliberation` (plan/wornSkill/wm seed, episode, terminate return) | **[LOOP]** land point + **[BOOK]** seed |
| 501-513 | `consciousThought.provision(...)` | **[→CORTEX]** session setup |
| 515-530 | dead-plan orphan sweep (`discardDeadPlanTodos`) | **[BOOK]** wm |
| 533-536 | `tick++`, `setEpisodeTick` | **[LOOP]** pace + **[BOOK]** |
| 538-574 | event drain (`Queue.poll` → `eventProcessor.processEvent`) | **[LOOP]** poll/dispatch |
| 576-602 | classify + critical interrupt (amygdala cut-the-line, exits `Interrupted`) | **[LOOP]** dispatch/exit (kills fibers + wm orphan discard **[BOOK]**) |
| 604-620 | poll in-flight `consciousFiber` (join turn, set `sessionId`/`stepReport`, `detectCompletion`) | **[→CORTEX]** session lifecycle |
| 622-658 | **HINDBRAIN inline triage** (`runHindbrain` `:636`) + `appraiseTick` reduce | **[→LIMBIC]** reflex (B2) — the reduce/escalation consumption stays **[LOOP]** |
| 660-698 | poll deliberation fiber, stale-discard or `applyDeliberation` land | **[LOOP]** seam |
| 700-713 | `willEvaluate` precompute (mirrors 6a guard) | **[→CORTEX]** (session/evaluate concern) |
| 715-730 | **5a idle path**: fork `runDeliberation` on snapshot | **[LOOP]** seam |
| 731-809 | **5b in-session ladder**: `reorient`/`interrupt` → `resetPlanState`; `steer`/`accumulate` → `runForebrain` (`:788`) → `formatSteerDirective` → `pendingDirective` | **[LOOP]** ladder dispatch; steer-orient is **[→LIMBIC]**; directive store is **[→CORTEX]** |
| 811-836 | step-exec guard (wedged-plan invariant, budget calc) | **[LOOP]**/**[→CORTEX]** |
| 837-999 | **6a evaluate** (`runConsciousEvaluate` `:854`, wm todo settle `:885-906`, episode step-end `:909`, `runDiaryTurn` `:934`, diary write, transition, per-step reset `:990-999`) | **[→CORTEX]** execute/evaluate + **[BOOK]** wm/episode/memory |
| 1000-1058 | **6b fork next turn** (turn-1 open `:1019`, steer turn `:1043`) | **[→CORTEX]** session lifecycle |
| 1062-1063 | `Effect.sleep(tickMs)` | **[LOOP]** pace |
| 1065-1082 | return-type annotation (`CortexResult`, R = 14 service tags) | **[LOOP]** (narrows as deps move out) |

**Net moves:**
- **→ cortex:** conscious-session lifecycle — the `consciousFiber`/`sessionId`/`stepReport`/`stepDoneSignaled` machinery + steer cadence state (`:235-245`), poll-in-flight (`:604-620`), turn-1 + steer forks (`:1000-1058`), `provision` (`:501-513`), and the evaluate/diary *execution* (`:854`, `:934`). New home: a `ConsciousSession` owner in `cortex/conscious/` (e.g. `conscious-session.ts`) that the loop drives via a small interface (`poll()`, `openTurn(step,…)`, `steer(directive)`, `evaluate(step,…)`, `interrupt()`).
- **→ limbic:** the hindbrain reflex — `runHindbrain` moves off the hot path into a limbic-owned scheduler/fork (B2), so a slow 2B call can't freeze the conductor. The `appraiseTick` reduce + escalation *consumption* stays loop-side (the conductor acts on the escalation).
- **stays in loop:** tick pacing (`tick++`/`sleep`), event drain/dispatch, classify + critical-interrupt exit, and the **orient→decide deliberation fork** (`runDeliberation`/`applyDeliberation`) — the one place licensed to reference both layers.
- **bookkeeping home:** wm mutations rehome toward `limbic/wm/*` composite helpers; episode transitions toward `logging/episodes.ts`; memory calls stay `MemoryGateway` (limbic/hippocampus). **Because much of this is limbic-owned, it must NOT ride along into `cortex/`** (see §4 constraint).

---

## 3. The hard constraint that shapes every extraction (READ THIS)

The Biome `noRestrictedImports` rule (`biome.json:24-115`) bans, at **error** level:
- `limbic/**` importing `#brain/cortex/**` or `**/cortex/**` (`:26-38`),
- `cortex/**` importing `#brain/limbic/**` or `**/limbic/**` (`:41-53`),
- and `transport/`, `services/`, `model/`, `core/` (except `core/orchestrator/`) importing cortex (`:55-114`).

The loop (`brain/loop/`) is **not** in any override → it is the **only** module allowed to import both layers. That is deliberate and load-bearing (BRAIN.md invariant #1).

**Therefore the evaluate/6a block cannot move to `cortex/` wholesale.** Its body calls `memory.recall` (`MemoryGateway` — limbic/hippocampus), `mutateWm`/`closePlanTodos`/`drainWmDeltas` (limbic/wm), alongside cortex `runConsciousEvaluate`/`runDiaryTurn`. Moving all of it into `cortex/conscious/` would create banned `cortex → limbic` edges. Split the seam:
- **cortex owns** the turn/session mechanics and the model calls (`turn`, `evaluate`, `diary`, session id, fiber lifecycle, steering pushes) — pure cortex + transport, no limbic import.
- **the loop keeps (or limbic absorbs)** the wm/memory/episode bookkeeping and threads results across the interface: loop gathers memory/wm context → hands it to the cortex session → takes back the model output → records wm/episode. `MemoryGateway` and wm helpers stay reachable from the loop, never from the new cortex module.

**Gate every phase on `npx biome lint` reporting 0 `noRestrictedImports` diagnostics.** If an extraction needs a banned import, the seam is drawn in the wrong place — redraw it, do not weaken the rule.

---

## 4. CRITICAL — behavior sensitivity + validation

This refactor is **not** the mechanical, unit-test-provable kind (unlike the recent import-alias / boundary-enforcement work). It **changes concurrency and timing**: B1 changes the live tick cadence, B2 forks a call that is currently inline, and A moves fiber ownership across a module boundary. Timing/interleaving bugs (a steer landing a tick late, an interrupt racing a turn join, a reflex result arriving after the tick that needed it) are invisible to the unit suite.

**The unit suite is necessary but NOT sufficient.** `loop.test.ts` runs against stub layers (`ConsciousThoughtTest`, fake memory, canned turns) — it exercises control flow, not real fiber timing against a live model server. It is also **part of the flaky baseline** (see §5), so it cannot even prove "no regression" cleanly.

**Every phase that changes runtime behavior MUST be validated with a live `roci-qa` smoke run** — a real container + model server + live loop ticks — before it is called done. Invoke the `roci-qa` skill; read its `CALIBRATION.md` first (it holds prior-run root causes). Per-phase validation is specified in §6. Phases marked *behavior-CHANGING* (B1, B2) require live QA to pass. Phase A1 is *intended* behavior-preserving but **restructures fiber ownership**, so it also requires a live smoke. A2/rename are lower-risk but still get one confirming smoke.

---

## 5. Standing gates & discipline (apply to EVERY phase)

- **Typecheck:** `nx run-many -t typecheck --skip-nx-cache` green across all 4 projects. Always `--skip-nx-cache` — the nx cache masks cross-package symbol breakage (a downstream app can be broken while a cached run reports green).
- **Unit suite at the flaky baseline:** only `packages/core/src/brain/loop/loop.test.ts` and `packages/core/src/core/orchestrator/planned-action.test.ts` may fail, **16–18 nondeterministic failures**. Anything outside those two files, or a *new* failure mode inside them, is a real regression. Capture the baseline in Phase 0 before touching code.
- **Biome:** `npx biome lint` at **0** `noRestrictedImports` diagnostics (§3).
- **Commits:** one commit per phase.
- **No PRs.** Pause for local merge approval; the human merges to main locally.
- **Base:** current branch tip, HEAD `be6c1988c85d8f769e263d1b3f8d8329b3ea992f`. Work on a feature branch off it.
- Edit via `git -C <worktree>` and target the session worktree's absolute paths — do not touch the main checkout.

---

## 6. Phased work

Each phase ends in an independently testable + committable deliverable. Order is fixed: **0 → B1 → B2 → A1 → A2 → rename.**

### Phase 0 — Characterization & baseline (behavior-preserving; no product code)
- **Deliverable:** (a) documented flaky-baseline snapshot (exact failing tests + count) from `nx run-many -t test --skip-nx-cache`; (b) a captured **live `roci-qa` smoke baseline** (loop ticks, a plan runs, a step evaluates) to compare every later phase against; (c) characterization notes / added assertions pinning the observable contracts the refactor must preserve: tick cadence source, steer coalescing/cadence (`DEFAULT_STEER_CADENCE_TICKS`), interrupt→`Interrupted` exit, evaluate transitions, wm todo settlement, episode step-start/step-end pairing.
- **Files:** `loop.test.ts` (add characterization tests only), a scratch baseline note.
- **Gate:** baseline recorded; typecheck green; biome 0.
- **Behavior:** preserving.
- **Delegation:** Coordinator → **1 IC (Opus** — needs judgment to identify the load-bearing contracts). Also produces the bite-sized TDD steps for B2/A1.

### Phase B1 — Thread the configured tick interval (behavior-CHANGING)
- **Bug:** the domain captures `tickIntervalSec` (spacemolt `phases.ts:117`,`:133`; github hardcodes `tickIntervalSec: 30` at `:17`,`:180`) but the `runCortex` call passes no `tickIntervalMs` (spacemolt `:170-180`, github `:241-250`), so the loop silently uses `DEFAULT_TICK_MS = 30_000` (`loop.ts:96`,`:179`).
- **Deliverable:** pass `tickIntervalMs: conn.tickIntervalSec * 1000` at both call sites. Confirm the connection value is the intended real cadence (see Risks Q1) before shipping.
- **Files:** `packages/domain-spacemolt/src/phases.ts` (activePhase call), `packages/domain-github/src/phases.ts` (call `:241`).
- **Gate:** unit at baseline; typecheck green; biome 0; **live QA smoke** confirming ticks fire at the connection cadence, not 30s.
- **Behavior:** CHANGING (live cadence). Small + isolated.
- **Delegation:** Coordinator → **1 IC (Sonnet).** Not a Team-Lead sub-tree.

### Phase B2 — Fork the hindbrain reflex off the hot path (behavior-CHANGING; bridges B→A)
- **Problem:** `runHindbrain` runs inline per state-changing event (`loop.ts:636`); a slow 2B reflex (observed up to ~17.5 min) freezes the whole conductor — critical interrupts and event draining stall. This is the first real decomposition step: **limbic owns/schedules its own reflex.**
- **Deliverable:** move per-event appraisal off the tick's blocking path — a limbic-owned scheduler/fork that appraises events concurrently and hands results back for the `appraiseTick` reduce, so the conductor never blocks on a reflex. Preserve the existing semantics: inert fast-path (`INERT_APPRAISAL`, `loop.ts:116`) unchanged; per-event `observeMemories` remember; the tick's escalation reduce still consumes all appraisals available. Decide + document the ordering contract (does a slow reflex's escalation apply on a later tick? — make it explicit and safe; it must not silently drop escalations or misorder an interrupt).
- **Files:** `packages/core/src/brain/limbic/tiers-limbic.ts` (owner/scheduler), `loop.ts:622-658` (call the scheduler instead of inline await), possibly `brain/loop/state.ts` (reduce timing).
- **Gate:** unit at baseline; typecheck green; biome 0 (the scheduler is limbic — must not import cortex); **live QA smoke** demonstrating a slow reflex no longer freezes the loop (finding G closed) and interrupts still fire.
- **Behavior:** CHANGING (concurrency).
- **Delegation:** Coordinator → **Team Lead (Opus)** — genuine concurrency judgment (ordering/backpressure), owns its own IC for the mechanical wiring. Right-sized as a small sub-goal, not a single IC.

### Phase A1 — Extract conscious-session lifecycle into cortex (behavior-preserving intent; restructures fibers)
- **Deliverable:** a `ConsciousSession` owner in `cortex/conscious/` (e.g. `conscious-session.ts`) that encapsulates the session lifecycle currently spread across the loop: `consciousFiber`/`sessionId`/`stepReport`/`stepDoneSignaled`/steer-cadence state (`loop.ts:235-245`), provision (`:501-513`), poll-in-flight (`:604-620`), turn-1 + steer-turn forks (`:1000-1058`), and the evaluate/diary **model calls** (`:854`,`:934`). The loop drives it through a narrow interface and keeps the wm/memory/episode bookkeeping loop-side (§3), threading context in and results out. Interrupt/steer semantics (§5-preserved contracts) must be byte-for-byte equivalent.
- **Constraint:** the new cortex module MUST NOT import `limbic/**` or `#brain/limbic/**`. Keep `MemoryGateway`, `wm-store`, and any limbic call in the loop; pass their outputs across the interface.
- **Files:** new `packages/core/src/brain/cortex/conscious/conscious-session.ts`; `loop.ts` (replace inlined lifecycle with interface calls); `loop.test.ts` (retarget `ConsciousThoughtTest` seams as needed).
- **Gate:** unit at baseline; typecheck green; biome 0; **live QA smoke** (steer, interrupt, evaluate, multi-step plan all behave as the Phase 0 baseline).
- **Behavior:** intended-preserving but fiber-ownership-restructuring → treat as behavior-CHANGING for validation.
- **Delegation:** **Team Lead (Opus)** — multi-step sub-goal with real integration judgment; delegates mechanical relocation to ICs, owns the interface design + reconciliation.

### Phase A2 — Rehome wm/episode bookkeeping (behavior-preserving)
- **Deliverable:** collapse the inline bookkeeping the loop assembles (step-end record assembly + plan-todo settlement `:876-920`, `resetPlanState` wm/episode parts `:295-337`, `applyDeliberation` seed `:456-483`, `emitWmRecord`/`discardPlanOrphans`) into composite helpers co-located with their owners (`limbic/wm/*`, `logging/episodes.ts`), so the loop calls a few named helpers instead of hand-rolling the records. No behavior change — pure relocation + naming.
- **Files:** `limbic/wm/wm-store.ts` (or a new `wm` composite helper), `logging/episodes.ts`, `loop.ts`.
- **Gate:** unit at baseline; typecheck green; biome 0; **one confirming live QA smoke** (wm todos settle, episodes pair correctly).
- **Behavior:** preserving.
- **Delegation:** Coordinator → **1 IC (Opus** for the judgment on helper boundaries; Sonnet acceptable if A1 left a clean seam).

### Phase Rename — `runCortex` → arousal/RAS name + directory decision (behavior-preserving)
- **Deliverable:** rename the now-thin conductor. Function `runCortex` → `runArousal` (candidate); resolve the directory question Q2 (`loop/` → `reticular/` or `arousal/`) and move if chosen. Update all imports (`domain-spacemolt/src/phases.ts:9`, `domain-github/src/phases.ts:12`, `loop.test.ts`, `#brain/loop/*` subpath alias if the dir moves), the `CortexResult` type if renamed, and docs (BRAIN.md, CORTEX.md, LIMBIC.md, HARNESS.md).
- **Files:** wide but mechanical — grep `runCortex`, `brain/loop`, `#brain/loop` across the repo.
- **Gate:** typecheck green (`--skip-nx-cache`); biome 0; suite at baseline; grep shows no stale references; **one confirming smoke** (the app still boots and ticks). If the directory moves, verify the `#brain/*` subpath alias still resolves (app launchers resolve `#brain/*` via default→dist with NO `--conditions` flag; vitest needs the `resolve.alias` mirror).
- **Behavior:** preserving.
- **Delegation:** Coordinator → **1 IC (Sonnet)** for the mechanical rename; verify the alias/resolution personally given the import-surface breadth.

---

## 7. Delegation model (for the executing session)

- **Coordinator = Fable 5** (the top-level session in dialogue with the human). Delegates; does not implement directly. Be mindful of context intake — hand artifacts as **files**, keep bulky code/diffs out of your own context. Curate, review, commit; let subagents carry the code.
- **Team Leads = Opus.** Use one when a phase is a multi-step sub-goal needing its own judgment/coordination: **B2** (reflex-fork concurrency) and **A1** (session extraction + interface design). A Team Lead owns the sub-goal and may delegate to its own ICs.
- **ICs = any model, always specified explicitly.** Mechanical/transcription-grade → Sonnet (B1, rename, A2-if-clean). Integration/judgment → Opus (Phase 0, A2 helper boundaries).
- **Don't over-delegate.** B1 is a single Sonnet IC task, not a Team-Lead sub-tree. Match topology to work.
- Per-phase suggestion: **0** Coordinator→IC(Opus); **B1** Coordinator→IC(Sonnet); **B2** Coordinator→Team Lead(Opus); **A1** Coordinator→Team Lead(Opus); **A2** Coordinator→IC(Opus); **rename** Coordinator→IC(Sonnet).
- Subagent model ceiling is Opus (Sonnet/Haiku fine). Worktree subagents fork from the repo base, not your moving HEAD — reconcile their branches on merge.

---

## 8. Risks & open questions

- **Q1 — B1 changes live cadence.** The loop was silently ticking at 30s; B1 makes it the connection's `tickIntervalSec`. For spacemolt that comes from `gameSocket.connect` (the game server dictates tempo); for github it's the hardcoded `30`. Confirm the intended real value with the human before shipping — a much faster real cadence multiplies model-server load and could surface contention that 30s masked.
- **Q2 — rename directory decision deferred** to the rename phase: `loop/` → `reticular/` vs `arousal/` (or leave the dir, rename only the fn). Settle it then, once the loop is genuinely thin; verify the `#brain/*` alias resolution if the dir moves.
- **A1 turn-ownership may shift interrupt/steer semantics.** Moving `consciousFiber` ownership behind an interface risks a one-tick lag or a race between `interrupt()` and turn-join. Pin these in Phase 0 characterization; validate on the live smoke.
- **B2 ordering.** A forked reflex whose result lands after its tick could misorder an escalation or an interrupt. Make the ordering contract explicit; never silently drop an escalation. The amygdala critical path (`loop.ts:576-602`) stays synchronous — do not fork *that*.
- **Bookkeeping can't follow execute into cortex** (§3): evaluate's `MemoryGateway`/wm calls are limbic; the split must keep them loop-side or Biome will (correctly) reject the extraction.
- **loop.test.ts is in the flaky baseline** — it cannot cleanly prove no-regression. Lean on the live smoke for every behavior-CHANGING phase; treat any *new* failure mode (vs the Phase 0 snapshot) as real.
