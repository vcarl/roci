# Docs-accuracy revision & deferred-follow-up backlog — session-kickoff handoff

**Date:** 2026-06-30
**For:** a fresh session (or sessions) picking up two missions now that C → A → B
have all shipped and the project is nearing functional.
**Role model:** lead-of-leads (per `~/.claude/CLAUDE.md`). The human-facing
session delegates; it does not implement directly. Mission 1 (docs accuracy) is a
big revision that likely wants **its own team lead**; Mission 2 (the backlog) is a
triage/sequencing job that can run separately.
**Sibling doc:** modeled on `docs/analysis/2026-06-30-subteam-b-memory-handoff.md`
(same shape — "where the project stands," grounded file:line sections, proven
workflow, operational learnings).

This handoff is grounded in a **real audit of the current tree** (worktree
`worktree-dream-sequence`, HEAD `9ddcff4`). Every in-code reference below was
opened and confirmed against actual files. Anything not confirmed is marked
**UNCONFIRMED**. Do not trust this summary alone — re-verify before acting.

Read these real docs first:
- `HARNESS.md`, `docs/DOMAIN_GUIDE.md`, `packages/core/src/core/limbic/LIMBIC.md`
  — the living architecture references (all three are stale; see Mission 1).
- `docs/analysis/2026-06-29-limbic-cortex-project-charter.md` — the charter with
  the **C / A / B outcome + deferred-follow-up** sections (Mission 2 source).
- `.claude/skills/roci-qa/CALIBRATION.md` — the QA dogfood log, runs 1–4
  (Mission 2 source).
- `docs/analysis/2026-06-30-subteam-b-memory-handoff.md` — the immediate
  predecessor; its workflow/learnings are reused below.

---

## Where the project stands

Three subteams shipped to the branch (not pushed), in the charter's strict
sequence **C → A → B** (charter "Launch order"):

- **C — Reliability** (`7c03328`): fail-loud `logError` → `kind:"error"` events,
  cortex fail-loud on diary/identity-read loss + empty-plan drops, in-container
  turn-timeout wrapper. (charter "Subteam C — outcome".)
- **A — Limbic drives** (`44b4388` drives, `b66967d` cortex): per-event hindbrain
  appraisal → graded escalation (`appraise`/`appraiseTick` →
  `HindbrainEscalation`), `!stateUpdate` deterministic fast-path, innate drives
  (`safety`/`sustenance`/`agency` core + `domainDrives`), `CortexState.escalation`
  seam. (charter "Subteam A — outcome (2026-06-29): SHIPPED".)
- **B — Long-term memory** (`b2b9d8f`→`9ddcff4`, 6 commits): append-only
  sqlite-vec store, baked `vec0.so`, in-container `memory` CLI (clone of
  `frontier`), host `mlx-embeddings` server, pre-cull diary promotion,
  `LongtermStore` seam. Live-integration-QA'd. (charter "Subteam B — outcome
  (2026-06-30): SHIPPED".)

Core suite 626 passed / 4 skipped at B's close; 4-project build green.

**Why this handoff exists.** The system is "nearing functional," so the cost of
stale living docs is no longer cosmetic — a new contributor or agent reading
`HARNESS.md` / `LIMBIC.md` / `DOMAIN_GUIDE.md` today is told the engine is
`runChannelSession()` in `orchestrator/channel-session.ts`, **a file and symbol
that no longer exist.** The actual engine is `packages/core/src/cortex/loop.ts`.
Meanwhile four shipped subsystems (cortex tier loop, drives, long-term memory,
the `frontier` delegation tool) are largely **undocumented** at the architecture
level. That is Mission 1. Mission 2 carries the deferred-follow-up backlog from
the charter + QA log forward.

---

## Mission 1 — docs-accuracy revision

### 1a. The guardrail: LIVING references vs DATED historical records

The doc tree has two kinds of documents, and the next session **must not treat
them the same**:

- **LIVING references** describe how the system works *now* and must be accurate:
  `HARNESS.md`, `README.md`, project `CLAUDE.md`, `docs/DOMAIN_GUIDE.md`,
  `docs/MODEL_CONFIG.md`, `docs/OPERATING_SKILLS.md`, `docs/cortex-smoke.md`,
  `packages/core/src/core/limbic/LIMBIC.md`,
  `packages/domain-spacemolt/src/SPACEMOLT.md`,
  `packages/domain-github/src/GITHUB.md`. These get the verify-every-reference
  pass.
- **DATED historical records** are point-in-time analyses/charters/specs/plans:
  **everything under `docs/analysis/`**, **`docs/superpowers/specs/**`**,
  **`docs/superpowers/plans/**`**, the two `docs/superpowers/2026-06-20-phases-
  0-4-*` review docs, and the **append-only QA log
  `.claude/skills/roci-qa/CALIBRATION.md`** (per-run dated entries).

**Do NOT retro-edit or "correct" the dated records.** Their line-number drift and
since-superseded model names are *expected* and are part of the historical
record. The charter explicitly accumulates outcome sections by appending
(C-outcome, then A, then B), and CALIBRATION appends one entry per run. Knowledge
is superseded by writing a **new dated doc** (like this one), never by rewriting
history. A reviewer who "fixes" `CALIBRATION.md`'s run-4 model names or the
charter's `loop.ts:205–211` cite has destroyed evidence, not improved a doc.

A few `docs/*.md` are **domain/external content**, not roci internals, and have no
in-repo symbols to drift: `api.md` (SpaceMolt game API, pinned "v0.146.0"),
`docs/onboarding.md` (in-game player guide), root `character-creation.md` (a
domain-agnostic interactive worldbuilding skill). Classify as LIVING but
**out of scope** for the in-code reference pass. (`docs/identity-gen-eval.md`,
`docs/literature-review-deliberation.md` not deeply audited — **UNCONFIRMED**;
treat as dated analyses unless shown otherwise.)

### 1b. Per-doc staleness table (verified)

| Doc | Class | Concrete stale in-code refs (verified file:line) | Fix size |
|---|---|---|---|
| `HARNESS.md` | LIVING | "primary execution engine is `runChannelSession()`" + `channel-session.ts` throughout (`:22–24,:28,:32,:119,:123,:137,:274`); `session-runner.ts` (`:275`) — **symbol & file deleted**. Key-Files tables omit the 4 real engine dirs `cortex/`, `conscious/`, `model/`, `core/orchestrator/`. **Zero** mention of cortex tiers / drives / long-term memory / `frontier` / escalation (grep: only "drives the sequence"). Data-flow + session-execution diagrams describe the deleted pipeline. 6-domain-service table still accurate. | **Large** |
| `core/limbic/LIMBIC.md` | LIVING | Opens "between raw domain events and the channel session orchestrator." Hypothalamus lists `session-runner.ts`→`runSession()` (`:22`) and `cycle-runner.ts`→`runCycle()` (`:28`) — **both deleted**; omits the real files `transport.ts`, `payload.ts`, `sdk-payload.ts`, `sdk-runner/`. Barrel-contract table (`:184`) claims hypothalamus exports `runSession`/`runCycle`/`SessionHandle`/`SessionResult`/`CycleConfig`/`CycleResult` — **actual `index.ts` barrel exports only `TempoConfig` family** (no runSession/runCycle/SessionHandle). Hippocampus omits the shipped `consolidate.ts` (documents only `dream`). | **Large** |
| `docs/DOMAIN_GUIDE.md` | LIVING | `runChannelSession` from `@roci/core/core/orchestrator/channel-session.js` in the PromptBuilder example (`:226–235`), the PhaseRegistry example (`:268–296`), and the checklist (`:418`) — deleted import path. Build cmd `pnpm check && pnpm lint` (`:424`). (SpaceMolt `situation.ts` cite at `:386` is actually **correct** — file exists, exports the Live layer.) No cortex/drives/memory mention. | **Medium–Large** |
| `docs/cortex-smoke.md` | LIVING | Model table wrong at every tier (`:17–20,:28–34,:71–83,:483–490`): lists hindbrain `Qwen3.5-9B`, forebrain `GLM-4.7-Flash`, conscious `Qwen3.5-122B-A10B`. **Actual `model/handles.ts`:** hindbrain `Qwen3.5-2B-4bit`, forebrain `Qwen3.5-9B-4bit`, conscious `gemma-4-31b-it-8bit`. Test count "100 passed, 2 skipped" (`:101,:107`) — now **626 / 4**. `frontier` + SDK-runner sections are current; doesn't yet mention the sibling `memory` CLI. | **Medium** |
| `docs/MODEL_CONFIG.md` | LIVING (incomplete) | Documents roles `brainPlan`/`brainInterrupt`/`brainEvaluate` (`:22–24`) — **orphaned: zero live call sites** (`resolveModel` is only called with `dreamCompression`/`timeoutSummary`/`dinner`). **Omits the entire live cortex MLX tier topology** (`model/handles.ts` `DEFAULT_CORTEX_MODELS` hindbrain/forebrain/conscious + `services/model-tier-spec.ts`). Live roles (dream/timeout/dinner/scaffold) accurate. | **Medium** |
| `README.md` | LIVING | Internally inconsistent: "channel session event loop" (`:5`), "channel session orchestrator" (`:16`), "channel session model" (`:105`) vs. the *updated* cortex/MLX prose at `:31`. Omits drives + long-term memory. `pnpm`-flavored commands coexist with HARNESS's `./roci` (both real). | **Small–Medium** |
| `CLAUDE.md` (project) | LIVING | "state machine event loop, brain/body execution model" + domain blurbs "plan/act/evaluate state machine loop" / "planned-action brain/body cycle" — stale framing (per MEMORY: "there is no body — it's the in-game opencode agent"). "6 injectable Effect service layers" still OK for domain services; doesn't mention `LongtermStore` or the cortex loop. | **Small** |
| `domain-spacemolt/src/SPACEMOLT.md` | LIVING | `runChannelSession` from `core/orchestrator/channel-session.ts` (`:3,:7,:19,:24`) — deleted. | **Medium** |
| `domain-github/src/GITHUB.md` | LIVING | `runChannelSession` from `core/orchestrator/channel-session.ts` (`:3,:7,:26`) — deleted. NB: MEMORY flags domain-github as "rusty / awaiting major revision" — don't canonicalize its patterns. | **Medium** |
| `docs/OPERATING_SKILLS.md` | LIVING | No stale in-code refs found — describes `packages/core/src/skills/` OODA templates accurately. | **None / verify** |
| `api.md`, `docs/onboarding.md`, `character-creation.md` | LIVING (external/domain) | No in-repo symbols; out of scope for the in-code pass. | **None** |
| `docs/analysis/**`, `docs/superpowers/specs|plans/**`, `…/2026-06-20-phases-0-4-*`, `.claude/skills/roci-qa/CALIBRATION.md` | **DATED** | Line/model drift expected. **Do not edit.** | **N/A** |

### 1c. The 5 most egregious verified stale references

1. **The engine is misnamed everywhere.** `runChannelSession()` /
   `orchestrator/channel-session.ts` is cited as the "primary execution engine"
   in `HARNESS.md`, `DOMAIN_GUIDE.md`, `LIMBIC.md`, `SPACEMOLT.md`, `GITHUB.md` —
   the symbol returns **zero** grep hits in code and the file does not exist. The
   real engine is `packages/core/src/cortex/loop.ts`.
2. **`LIMBIC.md` barrel-contract table is counterfactual.** It documents
   hypothalamus exports `runSession`/`runCycle`/`SessionHandle`/… ; the actual
   `core/limbic/index.ts` barrel exports only `TempoConfig`/`TempoBase`/
   `StateMachineTempo`/`PlannedActionTempo`. A reader importing per the doc gets
   a missing-export error.
3. **`cortex-smoke.md` will fail if followed verbatim** — it tells you to start
   model servers with three models that are not the configured defaults
   (`Qwen3.5-9B`/`GLM-4.7-Flash`/`Qwen3.5-122B` vs the real
   `Qwen3.5-2B`/`Qwen3.5-9B`/`gemma-4-31b-it-8bit`), so the smoke + live session
   would request models the servers don't serve.
4. **Four shipped subsystems are undocumented at architecture level.**
   `LongtermStore`, drives/`DRIVES`, `HindbrainEscalation`, and `frontier` appear
   in **none** of `HARNESS.md` / `CLAUDE.md` / `DOMAIN_GUIDE.md` (README mentions
   only the cortex tiers, at `:31`). The `conscious/`, `cortex/`, `model/`,
   `core/orchestrator/` directories — the live engine — are absent from
   `HARNESS.md`'s Key-Files tables.
5. **`MODEL_CONFIG.md` documents dead roles and omits the live tier system.**
   `brainPlan`/`brainInterrupt`/`brainEvaluate` have no live callers, while the
   actual cortex model topology (`model/handles.ts` + `model-tier-spec.ts`,
   hindbrain/forebrain/conscious) is entirely absent. There are effectively **two
   model-config systems** and the doc describes only the older Claude-tier one.

Bonus dead code confirmed (small, mechanical): `summarizeTimeout`
(`core/limbic/hypothalamus/timeout-summarizer.ts:15`) is exported but has **zero
call sites** and is not re-exported by any barrel.

### 1d. Recommended approach

This is a **big revision** (two Large rewrites + several Medium) that the human's
read suggests should get **its own team lead**. Recommended posture:

1. **Verify-every-reference pass.** For each LIVING doc, walk every in-code
   reference (file path, symbol, line cite, model name, command) and open it.
   Replace deleted refs with their live equivalents; this catches the
   long-tail drift the table above samples but doesn't exhaust.
2. **Sequence by blast radius.** `HARNESS.md` + `LIMBIC.md` first (they define
   the mental model everything else inherits), then `DOMAIN_GUIDE.md` +
   `SPACEMOLT/GITHUB.md` (downstream of the engine rename), then
   `cortex-smoke.md` + `MODEL_CONFIG.md` (mechanical model-name/topology fixes),
   then `README.md`/`CLAUDE.md` (summaries).
3. **Add, don't just fix.** The harder half is *describing the new subsystems*
   (cortex tier loop, drives, long-term memory, `frontier`) that no living doc
   covers — that's authoring, not find-and-replace. Ground each new section in
   the shipped specs (`docs/superpowers/specs/2026-06-29-limbic-drives-design.md`,
   `…/2026-06-30-longterm-memory-design.md`, the cortex specs) — but write the
   doc fresh against the code, not by copying the dated spec.
4. **Re-confirm before deleting.** The `runChannelSession`-era *concepts*
   (persistent session, channels) are gone, but pieces survive (`process-runner`,
   `transport`, `sdk-runner`, `TempoConfig`). Use
   `tracing-dead-code-after-deletion` discipline; don't assume a symbol is dead
   because the doc framing is.

---

## Mission 2 — deferred-follow-up backlog (deduped, severity-ranked)

Provenance keys: **[CH-x]** = charter outcome/deferred section; **[Bx]** =
Subteam-B handoff "Deferred follow-ups"; **[QA-rN]** = CALIBRATION run N.

### Tier 0 — Make-the-feature-live operational (do these to unlock shipped work)

- **O1 — `ROCI_EMBED_PYTHON` wiring [HIGHEST]** `[CH-B, B]`. Long-term memory
  ships but stays **dormant**: the embed launcher resolves Python via
  `ROCI_EMBED_PYTHON` (default `python3`), yet `mlx-embeddings` lives in
  `~/llm-env`; out of the box the host embed server logs-loud-and-skips and
  `memory search`/`remember` have no backend. Fix: default to the known venv
  python (mirror the existing `ROCI_LLM_ENV`→`~/llm-env` resolution README
  already documents for `mlx_lm.server`) or document in the runbook. Without
  this, Subteam B's value is unrealized.

### Tier 1 — Robustness / reliability

- **R1 — Transport retry/backoff [HIGH] (CONVERGENCE — dedup of two reports).**
  Same missing layer at two call sites: (a) cortex `callTier` — a transient
  `fetch failed` on a slow cold forebrain (>130s) **hard-fatals the loop with no
  retry** `[QA-r2]`; (b) the memory embed client — a slow cold first embed throws
  `HTTP <status>` and aborts `remember`/`search`, no backoff `[B]`. Build one
  retry/backoff+timeout utility and apply at both seams. The B handoff already
  notes its embed gap "mirrors the cortex transport-retry gap."
- **R2 — STUCK_STEP: in-session step is unbounded [HIGH] (product bug + detector,
  CONVERGENCE).** `[QA-r3 addendum, QA-r4]` A `STEP_START` with no `STEP_DONE`:
  the in-session loop does not bound a running body step and does not recover when
  a WS-reconnect strands the body (fuel frozen ~22 ticks). This is both a **real
  bug** and the **strongest unbuilt QA detector**. NB: branch commit `3c1d233`
  ("stop post-replan stall + never-started-step salvage") may address the
  *never-started* variant — **UNCONFIRMED** whether it bounds an already-running
  stuck step; re-verify before scoping.
- **R3 — `frontier` provisioning swallows errors [MED]** `[B]`. Still
  `catchAll(() => void)`; only the root-exec permission fix was applied. Same
  fail-loud treatment the rest of C/B adopted.
- **R4 — Orphan-reaping live verification [MED]** `[CH-C, B-adjacent]`. The
  in-container `timeout` wrapper (grace 60s / kill-after 10s, above host budget)
  is unit-tested as a pure function but needs a **live-container** check before
  being relied on.
- **R5 — Consecutive-failure escalation [MED]** `[CH-C]`. Repeated failed
  reflections log at error but don't escalate to a distinct critical — matters for
  long unattended runs.

### Tier 2 — QA detectors & observability (`apps/roci/src/qa/`)

(Several earlier-flagged detectors are **already APPLIED** — see "Resolved"
below. These remain open:)

- **D1 — STUCK_STEP detector** — see R2; the detector itself is unbuilt
  (`STEP_START` w/o `STEP_DONE` within N ticks + frozen state). `[QA-r3,r4]`
- **D2 — TIER_UNREACHABLE detector [MED-HIGH]** `[QA-r4]`. Probe the tier ports
  the live loop depends on; fire a named anomaly (and feed `terminalCause`
  precedence) when a depended-on tier is down. Top miss of run 4.
- **D3 — REPETITIVE_ORIENT / stagnant-headline** `[QA-r3]` — flag N consecutive
  near-identical forebrain headlines. It's the *symptom* of D1/R2; lower priority.
- **D4 — Digest blind-spots** `[QA-r1,r3,r4]`: **SESSION_END is never emitted**
  (enum exists, nothing emits it → `terminalCause` can't report a clean stop);
  and **no per-tier health / latency fields** (`firstForebrainMs` ~183s went
  unflagged; which-tier-down unknown).
- **D5 — `classifyEvent` coverage** `[QA-r2,r3]`: silently swallows `hindbrain:`
  non-escalate dispositions, `loop_start`, `Entering phase:` — low-priority
  chattiness/coverage; phase-transition classification pends a design call
  (OODA markers only vs orchestrator phases too).

### Tier 3 — Character pipeline / play quality

- **P1 — Confirm DIARY.md reaches orient/decide prompts [MED]** `[QA-r3]`. kvothe's
  identity lived only in `DIARY.md` (background/VALUES were boilerplate); verify
  the pipeline actually reads it, else coherence/values never reach the model.
- **P2 — Decision-context poverty** `[QA-r3]` — orient never surfaced the active
  mission chain; recorded as a prompt/orient-tuning observation, not a detector.

### Tier 4 — Deferred-by-design (decisions, not bugs — revisit only if pain)

- **B read-seam retrieval (spec Unit 8)** `[CH-B, B]` — backing whole-file diary
  reads at `cortex/loop.ts:316-318/410-412` (+ consolidate/dream) with retrieval;
  deferred because it touches the **hot loop** (rebase-contention risk).
- **FTS5 hybrid** for exact-fact recall `[CH-B, B]` — one planted-fact QA miss;
  vectors still won there. Later optimization. (Related: bge-small scores compress
  to ~0.46–0.62 — KNN ordering reliable, an absolute score threshold is risky.)
- **Active interrupt-kill** (`docker exec … pkill`) `[CH-C]` — a critical
  interrupt leaves a bounded orphan-until-budget; the active kill was intentionally
  not built (decision 2).
- **Abstract drop-everything emergencies as amygdala-style state rules** `[CH-A]` —
  the 2B empirically can't judge them (Finding 2); the complementary hindbrain
  `interrupt` rung is plumbed+gated but unexercised.

### Tier 5 — Shutdown hygiene (one root cause, partial mitigation exists)

- **H1 — SIGTERM signal handler [MED]** `[QA-r3 addendum, QA-r4]`. One root cause
  with three symptoms: on graceful SIGTERM (1) the Docker container lingers "Up,"
  (2) the monitor doesn't self-finalize, (3) spawned mlx tier servers leak
  (Effect scoped finalizers don't run on the signal). Wants a real signal handler
  that interrupts the root fiber so finalizers + container-stop run. Partial
  backstop already wired: `reapResidentServers` SIGTERM/SIGINT reaper in
  `apps/roci/src/main.ts` (run-4) group-kills the resident pid.

### Operational decisions for the human (not code bugs)

- **Conscious-tier strategy** `[QA-r3]` — QwQ-32B vs a dedicated-port 122B. NB:
  the live default is now `gemma-4-31b-it-8bit` (`handles.ts`), so the run-3
  framing is **superseded by config evolution** — re-pose against the current
  default, don't action the old text.

### Already resolved since flagged (note — do NOT re-action; do NOT edit the dated record)

- **Model-config divergence (run-4 HEADLINE) — RESOLVED in tree.**
  `services/model-tier-spec.ts:28–36` now **derives `model: handle.model`** from
  `DEFAULT_CORTEX_MODELS` (single source of truth) with a port/baseUrl
  cross-check that throws on drift. The run-4 "every tier disagrees" entry stays
  as a dated record.
- **Two info-level `logToConsole(..., "error")` sites — RESOLVED.** The charter's
  `loop.ts:168` / `planned-action.ts:97` anti-pattern is gone; `planned-action.ts`
  now carries warning *comments* (`:45–47,:81–83`) and emits `kind:"error"` /
  `logError`. `loop.ts:168` is unrelated code now.
- **FATAL_ERROR + DEGRADED_TIER detectors + `terminalCause` field — APPLIED**
  (run-3 commits `035425f`, `1083591`, `fcd7980`+`7aabcfa`). The run-1/run-2
  "queued" notes for these are superseded.
- **Most roci-qa SKILL.md playbook fixes — APPLIED** (launch via
  `node --import tsx`, mlx venv/PATH, log rotation, token filename) across runs.

**Top themes + counts:** Tier-0 operational ×1 (O1); Tier-1 robustness ×5 (R1–R5,
incl. two convergence dedups); Tier-2 QA detectors/observability ×5 (D1–D5);
Tier-3 play-quality ×2 (P1–P2); Tier-4 deferred-by-design ×4; Tier-5 shutdown
hygiene ×1-root-cause/3-symptoms; plus 4 resolved-since-flagged items to *not*
re-open.

---

## Proven workflow (reuse it — it carried C, A, and B)

1. **Team lead: investigation + design FIRST, no code.** Map current state with
   file:line cites; propose 2–3 approaches per decision with a recommendation;
   write a spec to `docs/superpowers/specs/`. The `superpowers:brainstorming`
   HARD-GATE applies: no implementation before an approved design. (For Mission 1
   the "design" is the verify-every-reference plan + the new-subsystem outline.)
2. **Lead-of-leads curates → batches decisions to the human**; records resolutions
   in a dated doc (charter-style), never by rewriting history.
3. **Spike before building when model-dependent.** A's spike caught the 2B's
   abstract-interrupt failure before a loop was built on a dead signal; B's three
   blocker spikes pinned sqlite-vec/bge-small before commit. Bring up only the
   model servers you need (`mlx_lm.server --model <m> --port <p>`), not a full
   `roci start`.
4. **Implement test-first, one unit at a time** — pure helpers first (the
   `cortex/state.ts`/`parse.ts` style).
5. **Independent review** (separate reviewer subagent); fold nits test-first.
6. **QA before commit earned its keep.** B's live-integration QA caught a
   production blocker (root-owned `/usr/local/bin` vs `node`-user exec → silent
   `Permission denied`, CLI never installs) that **unit tests + static review both
   missed** — and surfaced the identical pre-existing `frontier` bug. For anything
   touching the container or a live server, exercise the real path before
   committing. Read `roci-qa/CALIBRATION.md` first in any QA preflight — it holds
   prior-run root causes.
7. **Lead-of-leads curates the commits** (commit only when the human asks).

---

## Operational learnings (avoid re-hitting these)

- **Worktree discipline.** All work in `.claude/worktrees/dream-sequence`
  (branch `worktree-dream-sequence`); use `git -C <worktree>`; absolute paths
  *inside the worktree* — main-checkout paths make subagents edit the wrong tree.
  `isolation:worktree` subagents fork from the repo base, not your moving HEAD —
  reconcile on merge.
- **Pre-commit hook builds the full tree** (`nx run-many -t build`, all 4
  projects) on every commit. Incremental commits all build green as long as the
  full on-disk set is green; order commits so each is logically coherent.
- **The cortex is a hot, contended path.** `cortex/{loop,state,tiers,parse}` are
  touched by many threads (forebrain wake, proactive discovery, the three
  subteams). The two biggest deferred items (R2 in-session step bounding, the
  Tier-4 read-seam retrieval) live here — expect rebase conflicts and validate
  the full suite after any rebase.
- **No MCP — subprocess/bash invocations.** The whole long-term-memory tool is a
  `frontier`-style in-container CLI for exactly this reason.
- **Relayed-approval deadlock.** A subagent under a hard "do not implement" gate
  may refuse *coordinator-relayed* approval (it trusts only the user's own
  messages) and deadlock. Fix: don't argue — launch a FRESH agent whose first
  instruction is the go. Durable design docs make the swap lossless.
- **Don't spawn large simultaneous research fan-outs** — 1–2 focused subagents.
- **Ground handoffs in real docs + verified facts**, never synthesized-from-memory
  framing. This doc opened every reference it cites.

---

## Suggested launch structure

The two missions are independent and can run concurrently under a lead-of-leads:

1. **Spawn a docs-accuracy team lead for Mission 1.** Scope = the verify-every-
   reference pass over the 10 LIVING docs + authoring the four missing
   new-subsystem sections, sequenced by blast radius (HARNESS+LIMBIC → domain docs
   → cortex-smoke+MODEL_CONFIG → README+CLAUDE). Hard guardrail in its brief:
   **never touch a DATED record.** It is a big enough body of work to own a lead.
2. **Triage/sequence Mission 2 separately** (lead-of-leads, or a second team
   lead). Land **O1** first (unlocks shipped memory), then the **R1 transport
   convergence** and **R2/D1 STUCK_STEP** pair (highest robustness value), then
   the QA-detector batch, then re-pose the operational decisions. Keep the
   "already resolved" four out of the work queue and out of any doc edits.
3. **Coordinate on `cortex/loop.ts`.** Both the R2 bug fix and any doc rewrite of
   the engine touch the same hot file/concept — sequence them or worktree-isolate,
   per the charter's contention guidance.
