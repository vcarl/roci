# Limbic & cortex refinement — project charter & subteam launch prep

**Status:** launch prep (pre-launch). Awaiting user review.
**Date:** 2026-06-29
**Companion:** see `2026-06-29-limbic-cortex-primitives-analysis.md` for the
evidence base (file:line citations for every claim referenced here).
**Posture:** lead-of-leads. This charter decomposes the in-scope work into three
team-lead sub-goals. Nothing here is launched yet.

---

## Resolved decisions (from user, 2026-06-29)

These convert the analysis's open questions into binding constraints.

1. **The emotional signal becomes causal, modeled as threat/drive detection.**
   Emotional weight / threat detection drives escalation — threats and other
   time-sensitive stimuli escalate. Add a **baseline of innate biological
   motivators** (survival-need drivers of behavior) to the **character
   template**, as the grounding for tagging.
2. **Forebrain wake rhythm is OUT OF SCOPE** — owned by a separate, concurrent
   session. Guidance recorded for that session: wake on an internal rhythm, not
   on every non-discard event, *except* on hindbrain escalation. Our work must
   therefore expose a clean **hindbrain-escalation signal** as the contract
   between the two sessions.
3. **Memory becomes two tiers.** The diary stays as **working memory**. Add an
   **append-only long-term store** for retrieval, backed by a **vector DB**,
   exposed to the conscious agent as a **retrieval tool**. The conscious agent
   has *write* access to long-term memory; not all write paths are visible in
   code, and that is acceptable.
4. **Secrets stay in the cull.** Culling secrets is intentional — it is how
   agents self-evolve their semantic aspects. (The "semantic drift" flagged in
   analysis is a feature here, not a bug.)
5. **Reliability is high priority.** Wedged states and data loss must be fixed —
   repair, not paper over. The full silent-degradation list is real; address
   Medium/Low items too, especially if any raise thorny questions.

Tooling constraint (standing): expose agent capabilities as **subprocess
invocations, not MCP**.

---

## Decomposition into subteams

Three team-lead sub-goals. Each team lead runs its own design pass
(brainstorm → spec) for its sub-goal before implementing — the no-implementation-
before-approved-design gate applies at each level.

### Subteam A — Limbic drives: salience + threat-driven escalation (Thread 1)

**Sub-goal:** make the emotional/threat signal *causal* rather than advisory.
Tag salient/threatening events so that threats and time-sensitive stimuli
**drive escalation**, and ground the tagging in a baseline set of innate
biological motivators carried in the character template.

- **In scope:** hindbrain `observe` I/O and prompt (`skills/observe.md`,
  `ObserveResult` in `skills/types.ts`); per-event vs batch tagging
  (`cortex/loop.ts:141–158, 205–211`); the amygdala threat path
  (`limbic/amygdala/` InterruptRegistry); the escalation decision in the loop
  (consume per-event disposition for **selective** escalation); a baseline
  "drives" section in the character template / identity layer.
- **Out of scope:** forebrain wake rhythm (Subteam-external session). A only
  *produces* the escalation signal it consumes.
- **First establish (team lead's opening recon):** where the character template
  / identity-gen lives and how a baseline-drives section would be added; the
  amygdala InterruptRegistry interface and how threats are declared today;
  current escalation wiring at `loop.ts:205–211`; whether per-event tagging
  needs the hindbrain to return an array (`tiers.ts:102`).
- **Success:** a threat / time-sensitive event embedded in a noisy batch
  selectively escalates (noise does not); baseline drives present in the
  template and feeding the tagging; the escalation signal is exposed cleanly for
  the forebrain session to consume.
- **Scoping risk to confirm at launch:** does the "drives baseline" belong in
  the static character template, the identity-gen pipeline, or a new limbic
  config? Confirm before committing A's boundary.

### Subteam B — Long-term memory: append-only store + vector retrieval tool (Thread 3)

**Sub-goal:** keep `DIARY.md` as working memory; add an append-only long-term
memory backed by a vector DB (candidate: `sqlite-vec`, embedded/in-container),
exposed to the conscious agent as a **subprocess retrieval tool**, with the
conscious agent able to write to it.

- **In scope:** the new append-only store + embedding + retrieval; the
  subprocess tool interface the conscious agent calls (no MCP); preserving raw
  episodic memory append-only; optionally backing the existing whole-file read
  seams (`loop.ts:225`, `consolidate.ts:50`, `dream.ts:78–79`) with retrieval
  later.
- **Out of scope:** changing cull behavior (secrets stay culled — decision 4);
  the working-memory diary mechanics themselves.
- **First establish:** how tools are currently exposed to the conscious / Claude
  agent (the existing subprocess invocation pattern); the `charFs` read/write
  seams (`loop.ts:345–349`, `consolidate.ts`, `dream.ts`); whether `sqlite-vec`
  + a small local embedder run inside the container; what the conscious agent's
  current tool surface looks like.
- **Success:** the conscious agent can **write to** and **retrieve from** a
  persistent long-term store through a subprocess tool; raw episodic memory is
  retained append-only; the working-memory diary still functions.
- **Scoping risk to confirm at launch:** the subprocess tool wiring is the
  feasibility crux — confirm the pattern exists before committing B's plan.

### Subteam C — Reliability: wedged-state & data-loss repair (Thread 4)

**Sub-goal:** eliminate the High-severity silent failures; fail loudly where it
matters; structurally prevent wedged states.

- **In scope (High first)** — refined by the C investigation (see
  `docs/superpowers/specs/2026-06-29-reliability-repair-design.md`):
  - diary-turn timeout/error → silent data loss (`loop.ts:332–343`) — *accurate*.
  - consolidate/dream failure → stale memory (`planned-action.ts:42–54`) —
    *under-loud, not silent*: logged at **info** (the `"error"` arg is the source
    string, not the level), ranks like routine chatter.
  - turn timeout/interrupt **orphans the in-container child**
    (`transport.ts:171–196` + `payload.ts`) — *charter was imprecise*: the host
    `docker exec` client **is** reaped by scope teardown; the leak is the
    in-container process, which `docker exec` does not signal-forward.
  - empty-steps plan — **already prevented post-rebase** by the
    `decideSteps().length > 0` guard at `loop.ts:245`; residual work is making
    the silent *drop* loud + asserting the execution-block invariant
    (`loop.ts:287–290`).
  - Then Medium items (swallowed identity reads, parse fallbacks masking output,
    fragile `[STEP_DONE]` match) as they surface.
- **First establish:** reproduce/confirm each High failure; the project's Effect
  error-handling conventions; the process lifecycle in `transport.ts`.
- **Success:** each High failure either fails loudly with a logged event or is
  structurally impossible (empty-steps plan can't go active; a timed-out Docker
  process is killed; no silent diary data loss).

---

## Coordination hazards (lead-of-leads exposure)

Two cross-cutting risks that need a decision *before* launch:

1. **Shared-file contention.** All three subteams touch overlapping files —
   `cortex/loop.ts` especially (A: escalation; B: read seams; C: empty-steps +
   diary-turn), plus the hippocampus (`dream.ts`, `consolidate.ts`) for B and C.
   Parallel editing will collide. Options: (a) sequence the loop.ts-touching
   work; (b) isolate each subteam in its own git worktree (forked from base) and
   reconcile branches on merge; (c) assign single-owner files. **Recommendation:
   worktree isolation per subteam + a defined merge/reconcile order**, with C
   (reliability) landing first since its fixes are foundational and the other two
   build on a non-wedging loop.
2. **Cross-session seam with the forebrain work.** Subteam A produces the
   hindbrain-escalation signal that the *external* forebrain session consumes
   (decision 2). The two sessions must agree on that contract or they will fight
   over `loop.ts` escalation/wake code. Needs an explicit interface agreement.

---

## Launch order (decided 2026-06-29: strictly sequential)

User decision: **time is not a constraint; run the teams one at a time** to
minimize contention and merge conflicts. No parallel worktrees.

1. **C — Reliability** first. Foundational; a non-wedging, non-data-losing loop
   is the substrate A and B build on.
2. **A — Limbic drives** second, rebased onto C's landed work.
3. **B — Long-term memory** third, rebased onto A's landed work.

Forebrain-seam note: the non-thinking forebrain changes have **landed on `main`**
(separate session). This worktree is rebased onto `main` before C starts, so the
escalation/wake seam A touches is reconciled against shipped forebrain code
rather than a moving target.

Each subteam launch = delegate the sub-goal to a team lead, which opens with its
own design pass before implementation. The next team starts only after the prior
team's work is landed and this branch is rebased onto it.

---

## Pause point

This is the review gate. Before launching subteams, the user will:
- review this decomposition (scope, boundaries, order),
- decide the shared-file-contention strategy (worktrees vs sequencing),
- confirm/define the forebrain-session interface,
- and manage/compact historical context as needed.

---

## Subteam C — outcome & deferred follow-ups (2026-06-29)

C shipped via strict TDD; reviewer verdict APPROVE-WITH-NITS, core suite green.
Spec: `docs/superpowers/specs/2026-06-29-reliability-repair-design.md`.
Accepted design notes & deferred work (carry forward; revisit during/after A & B):

- **Issue 3 — orphan reaping is integration-only.** The in-container `timeout`
  wrapper (grace 60s + kill-after 10s, set *above* the host budget so the host
  timeout stays primary) is unit-tested as a pure function, but actual orphan
  reaping needs a **live-container check** before being relied on in production.
- **Issue 3 — active interrupt-kill deferred.** A critical-interrupt still leaves
  a bounded orphan-until-budget; the active `docker exec … pkill` path was
  intentionally NOT built (decision 2). Follow-up if the bounded orphan proves
  costly.
- **Issue 2 — consecutive-failure escalation deferred.** Repeated failed
  reflections log at error but do not yet escalate to a distinct critical
  (decision 4). Follow-up for long unattended runs.
- **Two pre-existing info-level failure sites** (the same cross-cutting
  anti-pattern, but outside the four-issue scope): `loop.ts:168`
  (event-processing) and `planned-action.ts:97` (runBreak) still use
  `logToConsole(..., "error")` which classifies to *info*. Convert to `logError`
  when convenient.

---

## Subteam A — design corrections (2026-06-29)

Design spec: `docs/superpowers/specs/2026-06-29-limbic-drives-design.md`. The A
investigation corrected several charter/analysis claims (verified on the post-C
tree):

- **The escalation gap is bigger than "make the single flag selective."** The
  `escalate` flag is consumed **only in the idle path** (5a); the **in-session
  path (5b) has no escalation consumption at all** — only `nonDiscard` drives a
  throttled steer. A must *add* an in-session escalation effect, not refine one.
- **The amygdala cannot host event-salience escalation.** `interrupts.criticals`
  is a hard-interrupt-to-**exit** path, and `InterruptRule.condition` is a
  `(state, situation) => boolean` state predicate with **no event access**.
  Hindbrain salience stays a separate LLM-judged, event-based route; amygdala
  unchanged.
- **`EventCategory` is dead only in the cortex** — it is **load-bearing in
  `runBreak`** (`planned-action.ts:113`). Do NOT remove it.
- **Line numbers shifted post-C**: observe/escalate logic is now
  `loop.ts:216–233` (was ~`:205–211`). Spec citations are re-verified.
- **Biggest risk (carry into implementation):** the whole mechanism depends on a
  2B, thinking-OFF hindbrain reliably emitting a well-formed `salient` array.
  Must be measured empirically before commit (like the forebrain thinking-off
  decision). Documented fallback: a leaner `threatLevel` batch field (loses
  selectivity, keeps graded escalation).

---

## Subteam A — resolved decisions (2026-06-29, from human)

These supersede the spec's recommendations where they differ; the spec must be
revised to match.

1. **Per-event processing, NOT batch.** The hindbrain is invoked **once per
   event** (no aggregation). Each event gets its own single-object
   emotional/threat tag — which *sidesteps* the array-parse risk that was the
   spec's biggest concern (single object out = parser happy path). This is a
   third path the human chose over both the salient-subset array (1C) and the
   full per-event array (1A). Closest to the original "each event its own tag."
2. **Hard-interrupt allowed at max threat.** Graded ladder: priority-steer →
   force-reorient → **and at max threat, hard-interrupt the in-flight conscious
   turn** (like an amygdala critical). Accepts that a hallucinated max-threat can
   discard in-flight work.
3. **Drives = ~2–3 domain-agnostic core + domain-provided.** A small core
   (~2–3) of domain-agnostic biological motivators lives in core; **domains can
   supply their own drives during character creation**. (Smaller than the spec's
   5; extensible per-domain.)
4. **Per-event `escalate` still triggers escalation.** Keep the `escalate`
   disposition as an escalation trigger, now evaluated per event.

Seam: `HindbrainEscalation` surfaced as a `CortexState` field (default), to
confirm with the forebrain-wake session. `EventCategory` left untouched.

**New open risk from the per-event pivot:** performance/cost of **N hindbrain
calls per tick** (≈ event count, heartbeats included). Must be assessed in the
spec revision + the empirical spike before implementation commits.

---

## Subteam A — Rev 2 resolved decisions (2026-06-29, from human)

- **Fast-path only, accept burst risk.** Deterministic discard (weight-0, no
  model call) for events with no `stateUpdate` is THE N-calls bound. No extra
  burst cap/time-box — a rare burst of many state-changing events may exceed the
  30s budget; accepted.
- **Spike FIRST, hold ALL code.** Run the empirical spike (A: per-event tagging
  quality; B: warm latency × N vs the 30s budget) BEFORE writing any
  implementation. The 2B must be proven before A is built. Model servers are
  currently down → bring them up to run it.
- **Core drives = `safety` / `sustenance` / `agency`.** (`purpose` & `belonging`
  live in the domain-provided set.)
- **Hard-interrupt trigger = explicit `interrupt:true`** from the hindbrain (not
  `weight:5` alone). Max weight alone only forces reorient; the model must
  deliberately choose to interrupt.
- Ride-along defaults (recommended, uncontested): tick `emotionalWeight` =
  dominant (highest-weight) event's mood; `HindbrainEscalation` as a
  `CortexState` field (confirm surface with the forebrain-wake session);
  domain-drives as structured `{name, description}`.

**Gate:** the spike is now the blocker before any A implementation.

---

## Subteam A — spike results (2026-06-29)

Harness (throwaway, reusable): `/tmp/claude-spike/spike.py` + `spike_v2.py`.
Server bring-up (minimal, no full runtime):
`/Users/vcarl/llm-env/bin/mlx_lm.server --model mlx-community/Qwen3.5-2B-4bit --port 8081`.

- **Spike B (latency) — GREEN, blocker retired.** Warm 1.62s/call; N=1/3/10 =
  1.6/4.9/16.2s, all within the 30s tick; the single server **parallelizes**
  (K=2/3 → 1.44×/1.71×), contradicting the earlier "serializes" prediction. With
  the `!stateUpdate` fast-path (N≈1–3) observe costs ~2–5s/tick.
- **Spike A (quality) — GO-WITH-TUNING.** Zero parse failures (single-object =
  parser happy path). The 2B reaches ~80% drive-correct with prompt tuning, BUT
  cannot simultaneously hold physical-emergency interrupt reliability AND
  abstract-threat sensitivity; temp 0.3 is noisy run-to-run. v1: nailed
  emergencies, ignored abstract threats. v2: caught abstract threats, regressed
  the safety-critical path (one run missed 2 emergencies — `interrupt:false` on
  weapons-lock & taking-damage).
- **The fragile axis = the safety-critical `interrupt` path** (the only rung that
  discards in-flight work).
- **Key architectural angle:** the physical emergencies the 2B is flaky on are
  largely what the **deterministic amygdala already catches** (SpaceMolt
  `in_combat`/`hull_critical` criticals). GitHub threats are abstract — exactly
  what v2 handles well. Splitting the load (amygdala owns physical-emergency
  interrupts; hindbrain owns the graded/abstract layer) resolves the 2B's
  both-poles tradeoff.
- **Tuning levers (for the implementer):** temp 0.0–0.1; few-shot anchors at BOTH
  poles; separate the `interrupt` criteria from the weight scale; `drive` is the
  weakest axis (candidate to drop to weight+interrupt if it won't stabilize).
- **Re-measure bar before implementation:** zero missed emergencies across
  ≥3 seeded runs, not just aggregate %.
- **Decision (2026-06-29):** tune the 2B once more (temp ~0, few-shot both poles,
  interrupt criteria separated from weight) **and the amygdala owns
  physical-emergency hard-interrupts** — the hindbrain's interrupt becomes
  complementary (abstract emergencies the amygdala doesn't cover), not the sole
  guardian. Re-measure the combined system before any implementation. This
  refinement must be written into the design spec.

### Re-measure (Rev 3) — GO for implementation (2026-06-29)

Tuning cleared the gate. Spec is now Rev 3.
- **temp 0.0** → 3 seeded runs bit-identical (run-to-run noise eliminated).
- drive-correct **85%**, weight-in-band **92%**, **zero false `interrupt:true` on
  benign**, **zero system-missed emergencies**, stable across seeds. Latency
  re-confirmed (~1.69s/call). `drive` KEPT (85% clears the bar).
- **Amygdala-coverage mapping confirmed:** every physical emergency in the eval
  set is an amygdala `critical` (SpaceMolt `in_combat`/`hull_critical`, GitHub
  `ci_failing_main`); GitHub has no physical criticals. The 2B owns the
  abstract/graded layer; its `interrupt:true` is complementary.
- **Flagged gap (fold into implementation, not a blocker):** the eval set has no
  *abstract* drop-everything emergency, so the 2B's complementary `interrupt:true`
  rung is designed-but-unexercised. Add 1–2 such cases (e.g. "account termination
  in 60s") to the test set before relying on that rung.
- **Still open before/at implementation:** confirm the `HindbrainEscalation` seam
  surface (default: a `CortexState` field) with the forebrain-wake session.

### temp-0.05 re-measure + eval-gap (2026-06-29) — graded layer GO, interrupt rung HELD

- **Finding 1 — temp 0.05 is safe for the graded layer.** Zero false
  `interrupt:true` on benign across 3 seeds at 0.05 (the safety bar holds); drive
  ~86% / weight ~86% on the owned layer. 0.05 reintroduces mild ±1 variation
  (the human's intent). **Use the v3.2-verbatim interrupt wording** — a
  generalized variant let an abuse event false-fire once.
- **Finding 2 [DECISIVE] — the 2B cannot do ABSTRACT-emergency interrupts.** Fed
  two real abstract drop-everything emergencies (account termination in 60s;
  irreversible data-loss in 45s), the 2B **never** fired `interrupt:true` —
  across both wordings and all 3 seeds; it scored them discard/0. Not a temp
  artifact (fails at 0.0 too). The Rev 3 "2B owns the abstract interrupt as its
  complement" is **non-functional on the 2B**. More prompt-tuning is not the fix.
- **Revised verdict:** GO for the graded layer (steer/reorient) at 0.05 — the
  bulk of A's value, proven & implementable. HOLD the 2B hard-interrupt rung
  (unit 7 top rung + unit 9 premise) pending the human's decision:
  1. (recommended) hard-interrupt is amygdala-owned, full stop; 2B caps at
     reorient; `interrupt` stays plumbed+gated but the 2B isn't relied on to set
     it. Abstract drop-everything emergencies, if real in-domain, become
     deterministic amygdala-style state rules.
  2. escalate the abstract-emergency appraisal to a stronger tier (9B forebrain)
     if a graded LLM interrupt is truly required (latency fits).
- Units 1–6 and 8 (pure helpers, schema, drives, graded observe.md, fast-path,
  per-event invocation, the `HindbrainEscalation` seam) are unaffected by
  Finding 2 and ready to build once the human lifts the gate directly.

### Subteam A — outcome (2026-06-29): SHIPPED

Implemented (9 units, TDD), reviewed (APPROVE-WITH-NITS, all 3 nits folded
test-first), committed in 2 logical commits. Core suite 455 passed / 4 skipped.
- `3d90d14` feat(drives): innate biological-motivator baseline (safety/sustenance/
  agency core + DRIVES.md + readDrives + scaffold + identity-gen + `domainDrives`
  hook; github=stewardship, spacemolt=voyage).
- `4914e09` feat(cortex): per-event threat appraisal drives graded escalation
  (per-event invocation, `!stateUpdate` fast-path, `appraise`/`appraiseTick` →
  `HindbrainEscalation`, graded ladder steer→reorient, `interrupt` plumbed but
  amygdala-owned/2B-caps-at-reorient, `CortexState.escalation` seam, temp 0.05).
- **Seam contract for the forebrain-wake session:** `CortexState.escalation:
  HindbrainEscalation { rung, maxWeight, escalate, dominant, accumulated,
  reasons }`. `escalate === true` (rung ≥ steer) is the off-rhythm wake signal;
  guaranteed non-undefined every tick.
- **Deferred follow-ups:** abstract drop-everything emergencies as deterministic
  amygdala-style state rules (the 2B can't judge them — Finding 2); the
  complementary hindbrain-interrupt rung is plumbed+gated but unexercised by the 2B.

---

## Subteam B — resolved decisions (2026-06-30, lead-of-leads)

Design spec: `docs/superpowers/specs/2026-06-30-longterm-memory-design.md`. The B
investigation **resolved the feasibility crux GREEN**: the conscious agent
already invokes an in-container bash subprocess tool (`frontier`) — generated
script base64-piped to `/usr/local/bin/<tool>`, provisioned idempotently in
`conscious-thought.ts` `provisionImpl`, documented in the agent-markdown system
prompt. A `memory` CLI is a near-verbatim clone — **no MCP, no new transport, no
hot-loop change.** The store is greenfield (zero sqlite/vector deps today).
Deployment GREEN: host `players/` is bind-mounted RW at `/work/players`, so a db
under `players/<name>/me/` is the same file host↔container; firewall allows
`host.docker.internal` (blocks HF/models.dev).

Lead-of-leads calls (human granted "no approvals needed; the plan is all there"):

1. **Storage = `sqlite-vec` + `bun:sqlite`,** one file `players/<name>/me/
   longterm.db` (WAL). In-container `memory` CLI is a bun script (matches
   `frontier`/`/work/bin` precedent, no native build). *Pending Spike 1.*
2. **Embedding = host embeddings server,** reached at `host.docker.internal:<port>`
   (mirrors the conscious-provider host-native pattern; charter decision 3 binds
   "a **vector DB**", so this is the v1 target). **FTS5 lexical is the documented
   fallback** only if the embedding spike disappoints. *Pending Spike 2.* Standing
   up the embed server (a non-mlx binary — mlx_lm.server can't embed) is **in B's
   scope** (resolves spec ambiguity S2).
3. **Pre-cull promotion hook = YES** (resolves S1). A deterministic step in
   `runReflection` (`planned-action.ts:34-65`, NOT the hot loop) reads the diary
   and appends new-since-last-promotion entries to long-term **before** the
   destructive `dream` cull — this is what actually retires the
   destructive-forgetting risk the whole thread targets. A read-before-promote
   does not change cull *behavior*, so it is in-bounds. Built as a **separable
   unit** (spec Unit 7) so it can be dropped without unwinding the core.
4. **Write paths:** Route 1 = explicit `memory remember "<text>" [--tags …]` the
   conscious agent calls (charter-required). Route 2 = the promotion hook (#3).
5. **Per-character store** under `players/<name>/me/` (identity isolation —
   resolves S3; no cross-character shared memory).
6. **CLI shape** (clone of `frontier`): `memory remember|search|recent`, NDJSON
   stdout for `search`, documented in `buildCharacterAgentMarkdown`. **Schema:**
   append-only `memories(id,ts,source,tags,text)` + `vec0` virtual table keyed by
   id (+ optional `fts5` for hybrid/fallback). Provenance `source` distinguishes
   `conscious` vs `promotion` writes.

**Gate:** implementation HELD pending the two BLOCKER spikes (Spike 1: sqlite-vec
loads under `bun:sqlite` in the real container image, KNN returns ranked rows;
Spike 2: host embed source + retrieval quality on a character-memory corpus).
Backing the whole-file read seams at `loop.ts:316-318/410-412` with retrieval
(spec Unit 8) is **explicitly out of B's core** — it touches the hot
`cortex/loop.ts` and is deferred to a follow-on phase to avoid rebase contention.

### Subteam B — spike results (2026-06-30): GO

All three blocker spikes PASSED; implementation gate lifted. Pinned parameters:
- **Spike 1 (sqlite-vec under bun in-container) — PASS.** sqlite-vec **0.1.9**
  linux-arm64 `vec0.so`, baked into the image (not downloaded in-container —
  dodges the egress firewall). Load via `db.loadExtension(path,
  "sqlite3_vec_init")` — the **explicit entrypoint is required** (bun's
  filename-derived default `sqlite3_vec0_init` mismatches). KNN:
  `WHERE embedding MATCH ? AND k = ? ORDER BY distance`; vectors inserted as JSON
  strings. bun at `/home/node/.bun/bin/bun`.
- **Spike 2 (embeddings + retrieval quality) — PASS.** `mlx-community/
  bge-small-en-v1.5-bf16`, **384-dim**, served by `mlx-embeddings` (native MLX on
  host) behind OpenAI-shape `/v1/embeddings`; container reached
  `host.docker.internal:<port>` in ~17ms/embed end-to-end. Plain text, **no**
  instruction prefix. Topical/paraphrase recall strong, clean noise separation;
  one exact-fact miss where **vectors still beat FTS5** (hybrid FTS5 = later
  optimization, not a blocker). **Firewall must whitelist `host.docker.internal:
  <embed-port>`.**
- **Spike 3 (cross-process WAL) — PASS.** WAL + `busy_timeout=5000` handles
  concurrent in-container writers/readers cleanly (integrity ok). **Flag:**
  host-side `bun:sqlite` opening the same WAL file Bus-errors on macOS — so the
  db is **in-container-access-only**; the host runs only the embed HTTP server.
- **Decision:** GO. Embed model bge-small/384-dim, sqlite-vec 0.1.9, WAL +
  in-container-only. FTS5 hybrid carried as a documented later optimization for
  exact-fact recall, not part of B's core.
