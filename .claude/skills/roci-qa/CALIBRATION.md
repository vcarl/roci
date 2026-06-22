<!-- .claude/skills/roci-qa/CALIBRATION.md -->
# roci-qa calibration log

Each QA session appends one dated entry: observations → decided changes → applied/queued.
New named anomaly detectors and threshold changes are born here (the dogfood loop).

<!-- template:
## YYYY-MM-DD — <char>/<domain>

**Observations:** ...
**Misses → new detector:** ...
**False positives → threshold/narration change:** ...
**Digest blind spots → new field:** ...
**Status:** applied | queued
-->

## 2026-06-21 — kvothe/spacemolt (first live triple-dogfood run)

First real wiring of app + qa-monitor + skill together. Run did **not** reach a clean
multi-tick session: it died on **tick 1** at the first hindbrain model call, so the monitor was
never launched live and **no `run-digest.json` / baseline** was produced. The happy path *up to*
the first model call is healthy — token validates in-container, WebSocket login as `kvothe in
"First Step"` succeeds, loop reaches phase `active` with real game state (`docked fuel:51%
hull:100% cargo:9/75`). 13 events captured in `players/kvothe/logs/events.jsonl` (a useful
crash/PROCESS_DIED fixture). Two blocking app bugs found en route; the bridge and digest are
still largely **unexercised** pending a clean run.

### App findings (cortex/orchestrator)

- **Bug A — firewall strict-mode kills the container, misreported as bad token.**
  `init-firewall.sh` runs `set -euo pipefail`; it dies on `ERROR: Failed to resolve
  statsig.anthropic.com` (telemetry domain; `api.anthropic.com` resolves fine). Script exits →
  `&& sleep infinity` never runs → container exits (code 1) → orchestrator's `docker exec`
  token-validation gets **exit 137** and surfaces it as *"OAuth token is not valid inside
  container"* (`orchestrator.ts:127`, `OAuthToken.ts:84`). Token is actually valid (proved via
  firewall-bypassed `docker run … claude -p ping` → "Pong!"). **Fixes:** (1) make non-essential
  domains (statsig/sentry) non-fatal in `init-firewall.sh` (resolve in a `|| true` block, not
  under `pipefail`); (2) in `validateInContainer`, distinguish "container not running / exec
  137" from "auth rejected" so the error message is truthful. Worked around this run with the
  supported `SKIP_FIREWALL=1` (plumbed at `orchestrator.ts:49`).
- **Bug B — hindbrain default is a reasoning model; loop fatals on tick 1.** Default hindbrain =
  `mlx-community/Qwen3.5-9B-4bit` (`handles.ts:48`), a reasoning model. Under the real triage
  prompt it spends its token budget on `message.reasoning` and returns empty `message.content`;
  the client throws `malformed response: missing choices[0].message.content` → loop fatal. **No
  runtime override exists** — `cortexModels` is never populated anywhere, so `loop.ts:96` always
  falls back to `DEFAULT_CORTEX_MODELS`. **Fixes:** (1) cortex client tolerates reasoning-only
  responses (adequate `max_tokens` / read `content` after `reasoning`); and/or (2) add a
  runtime cortex-tier override path (file/env/flag) mirroring the frontier `--tier-*` flags;
  and/or (3) pin non-reasoning instruct defaults for the local tiers.

### Misses → new/changed detectors (`apps/roci/src/qa/markers.ts`)

- **Loop-killing errors escape ERROR.** `Fatal error: Model call failed …` is `kind:"system"`
  but matches no regex, so it does **not** trip ERROR — only `--session-pid` PROCESS_DIED caught
  the death. Broaden the prime candidate `/^event error:/` to also cover `/^Fatal error:/` and
  `/Model call failed/` (and `diary write failed:`). **New detector candidate.**
- **Phase transitions are not classified.** Orchestrator `Entering phase: <x>` lifecycle lines
  match nothing, so no TRANSITION beat fires for startup→active. If the design wants phase beats
  narrated (per §3 "narrate the beat"), add `^Entering phase: (\w+)$` → TRANSITION. **Decision
  needed: is the intended "transition" the OODA marker set only, or also orchestrator phases?**

### False positives / chattiness

- N/A this run — the monitor never ran live (no clean session to observe). Re-assess next run.

### Digest blind spots → new field (`apps/roci/src/qa/digest.ts`)

- A crashed run is indistinguishable from a clean one in the fingerprint: the tick-1 fatal is
  `kind:"system"`/unclassified, so it folds into nothing. Add a **terminal-cause field**
  (`terminalError` / `diedAtTick` / `exitReason`) so digests/baselines can tell "completed" from
  "died at tick 1 on a model error." Also still missing tier-health + latency (known).

### Skill / playbook fixes (`.claude/skills/roci-qa/SKILL.md`)

- **§1 preflight — add an on-disk identity check.** `players/` is gitignored (`.gitignore:16`),
  so it's empty in a fresh worktree. Verify `players/<char>/me/{background,VALUES,DIARY}.md`
  exist before launch; none did (had to copy `kvothe` in from `testbench/roci-testing`).
- **§2 launch snippet — `npx tsx …` fails.** `tsx` is only installed under `apps/roci`. Use
  `apps/roci/node_modules/.bin/tsx <script>` or `npx --prefix apps/roci tsx <script>` (the repo's
  `./roci` wrapper already does the prefix). Applies to both the session and the monitor commands.
- **§2 — wrong `--session-pid`.** As written the snippet pipes through `tee`, so `$!` is tee's
  PID, not the session's → PROCESS_DIED never fires. Capture the real PID via
  `pgrep -f "main.ts start <char>"` after launch. (Also the snippet omits the backgrounding `&`.)
- **Setup gap — config.json membership required.** A copied-in identity must also be added to
  `config.json` under `<domain>.characters[]`; `resolveConfigs` intersects the char arg with
  config.json, else "No domains/characters matched." Had to add `kvothe`.
- **Setup gap — token filename.** Orchestrator loads `<projectRoot>/.oauth-token`, but the repo
  ships the token as `auth-token` (different name). Preflight should check/copy `auth-token →
  .oauth-token`.
- **§1 — firewall awareness.** On a host that can't resolve every firewall domain, the session
  dies at validation with a misleading message (Bug A). Preflight should test the firewall path
  or recommend `SKIP_FIREWALL=1` for local runs.
- **Step-1 tier smoke false-fails reasoning models.** `client.smoke.test.ts` uses too small a
  `max_tokens`; reasoning models exhaust it on `reasoning` and report "missing content" though
  they're healthy with adequate budget (all 3 tiers false-failed). Bump the smoke budget or pin
  non-reasoning smoke models; the skill should not treat that smoke failure as a hard stop
  without checking the token budget. (This is the same root cause as Bug B.)
- **Monitor reads from offset 0**, not tail — it replays a pre-existing `events.jsonl` as fresh
  beats. The skill should say to start against a fresh/empty events file (done manually here), or
  the monitor should support `--from-end`.

**Status:** partially applied.
- **Bug A (firewall strict-mode → misreported token): APPLIED** (2026-06-21, parallel fix
  session). All three `init-firewall.sh` copies split essential vs non-essential telemetry
  domains (statsig/sentry resolve best-effort outside `pipefail`); `OAuthToken.ts` gained
  `classifyValidationResult()` + `isContainerRunning()` and the orchestrator now reports
  container-down truthfully instead of blaming the token. Covered by `OAuthToken.test.ts` (7) +
  `init-firewall.test.ts` (9). Not yet proven on a real Docker run — next QA pass exercises it.
- **Bug B (reasoning-model hindbrain → tick-1 fatal): APPLIED** (2026-06-21, same session).
  `client.ts` tolerates reasoning-only responses (`content` → `reasoning` → `reasoning_content`,
  still fails loudly if none yield text); `handles.ts` pins `maxTokens` on all local tiers.
  Covered by `client.test.ts`, `handles.test.ts`, `tiers.test.ts` regression. Runtime cortex-tier
  override path (fix candidate 2) **deferred** as a follow-up (orchestrator-level). Not yet proven
  against a live MLX server — next QA pass exercises it.
- **Still queued** (not worked this round, candidates for a future session): the detector changes
  (`markers.ts` — `Fatal error:` / `Model call failed` / phase-transition classification), the
  digest terminal-cause field, and the SKILL.md playbook fixes. Treat with normal TDD/review
  discipline.

## 2026-06-21 (run 2) — kvothe/spacemolt (first clean multi-tick run)

With Bug A + Bug B applied, the session **cleared tick 1 for the first time** and exercised the
full ladder live: hindbrain → forebrain → conscious(plan) → body(`opencode run` in container).
Both fixes validated on metal (firewall ON, truthful token validation; hindbrain `accumulate`,
no tick-1 fatal). The run ended in a **self-inflicted `PROCESS_DIED`** (see methodology miss).

**New product finding → forebrain reasoning-model parse failure (same family as Bug B, one tier up).**
`GLM-4.7-Flash-4bit` (forebrain default, `handles.ts`) is a **reasoning model**. Its chain-of-thought
length is highly variable; when it exceeds the 4096 `maxTokens` budget the model hits `finish=length`
with `completion_tokens=4096`, `content=""`, and never emits the OrientResult JSON → `parseOr`
fallback `"Orient parse failure — situation unknown"` (`tiers.ts:105`). Directly observed: 2/6 warm
probes failed this way (reasoningLen 7465 / 13226), 4/6 passed (`finish=stop`, reasoning ~5.4–6.3k +
content ~1.0–1.2k). **The Bug-B `content→reasoning` client fallback does NOT rescue this** — the
reasoning prose isn't JSON (`Unterminated fractional number`). Fix candidates (deferred to the new
tack): pin a non-reasoning instruct model for forebrain (Qwen2.5-32B-Instruct / Mistral-Small-Instruct
are on :8082), and/or strip reasoning + raise/budget tokens, and/or add a parse-failure retry.

**New product finding → transient cortex transport errors hard-fatal the session.** Cold/uncached
forebrain calls are slow (`firstForebrainMs` 130s; an uncontended cold probe exceeded 240s). When a
forebrain `fetch` outruns the transport, the resulting `fetch failed` fatals the loop with **no
retry/backoff**. Ties to the queued `markers.ts` note that `Model call failed` escapes the ERROR
detector. Fix candidate (new tack): retry/backoff + timeout tolerance around `callTier`.

**Methodology miss (QA discipline) → never load-test a server the live session depends on.** The
local MLX servers **serialize** inference. A repro batch of heavy 4096-token orient probes against
:8082 contended with the live forebrain call → `fetch failed` → killed the live session (the
`PROCESS_DIED` above). Run repros only when no session is live, or against a separate instance/port.

**Monitor calibration applied this run.** `--stall-multiple 20` (≈10-min threshold at a 30s tick)
**eliminated the false STALLs** that fired last check-in on slow conscious/body ticks, while still
catching the real `PROCESS_DIED` and writing `run-digest.json`. Confirmed-good change; the monitor
default stall-multiple should rise (conscious + body steps routinely exceed 2× tick). Still unflagged:
`hindbrain:` dispositions, `loop_start`, `Entering phase:` (FOREBRAIN/DECISION/STEP_START do classify).

**Status:** forebrain/hindbrain fix **APPLIED** via the chosen tack — swap structured-output tiers
to non-reasoning instruct models (`handles.ts`): hindbrain → `Qwen2.5-7B-Instruct-4bit`, forebrain →
`Qwen2.5-32B-Instruct-4bit`. Verified empirically before the swap (both candidates: `finish=stop`,
`reasoningLen=0`, JSON parses). conscious left as the reasoning model `Qwen3.5-122B-A10B-4bit` by
decision (designated deep-reasoner, 8192 budget, held up in the run). Guarded by a new
`handles.test.ts` regression (structured tiers must be instruct, not a known reasoning model);
full suite 252 passed. **Not yet proven multi-tick on metal** — next QA pass validates the live
forebrain orient no longer hits the parse-failure fallback. Still **deferred**: transport
retry/backoff for the fetch-failed-fatal gap, and the `markers.ts` ERROR-detector additions. Repro
artifacts (`players/kvothe/qa/repro-orient.ts`, `repro-out.txt`) discarded.

## 2026-06-21 (run 3) — kvothe/spacemolt (behavior-quality phase)

First run targeting **play quality** after the instruct-model swap. The **122B conscious tier**
(`mlx-community/Qwen3.5-122B-A10B-4bit`) crashed all 3 sessions at tick 0 — cold-load race on the
on-demand `:8083` umbrella server (`firstForebrainMs` ~183s; likely timeout/OOM on the shared
128 GB pool). Conscious swapped to `mlx-community/QwQ-32B-4bit` (commit `dceb202`) and all 3
tiers pre-warmed before launch. Result: session survived ~12 ticks with 2 DECISIONs and a
dispatched body action vs 0 ticks before. QwQ-32B produces clean parseable decisions — **not** a
reasoning-only fallback. Prompt laundering verified clean: no raw inbound event text reaches
conscious prompts; the invariant now has a named test (`loop.test.ts:634`).

### Misses → new detectors (`apps/roci/src/qa/feed.ts`)

- **FATAL_ERROR** (commit `035425f`; `AnomalyType += FATAL_ERROR`). Fatal errors arrive as
  `kind:"system"` with text matching `Fatal error:` / `Model call failed [tier=…]`. The existing
  ERROR detector only fires on `kind:"error"`, so all 3 deaths this run were invisible to the
  monitor — caught only by the PROCESS_DIED watchdog. New branch parses tier + model into `refs`.
  Confirms the queued detector note from run 1 and run 2.
- **DEGRADED_TIER** (commit `1083591`; `AnomalyType += DEGRADED_TIER`; severity warn). Real
  fixture from this run: `hindbrain: undefined undefined` (`events.jsonl` line 22) — a
  `parseOr`-swallowed tier-parse failure that was silently dropped before. This is the
  "silent fallback hides a degraded tier" failure mode flagged at kickoff. Regex
  `/^(hindbrain|forebrain|conscious): undefined\b/`; tier extracted into `refs`. Both detectors
  implemented TDD with reviewed tests.

### False positives / chattiness

None this run. The WebSocket `Reconnect failed: Timed out waiting for welcome` at t4 correctly
fired as an ERROR anomaly (`kind:error`) and the session recovered — detector working as intended.
No threshold changes needed.

### Digest blind spots → new field (`apps/roci/src/qa/digest.ts`)

- **`terminalCause: string | null`** (commits `fcd7980` + leak-fix `7aabcfa`). Precedence order
  `FATAL_ERROR > PROCESS_DIED > SESSION_END`, so the root cause is reported rather than its
  downstream consequence. Not yet exercised end-to-end on a real terminal event: the current run
  was still alive when the digest was written, and prior on-disk digests predate the field. A leak
  bug (internal `_terminalRank` being serialized into `run-digest.json`) was caught in review and
  fixed via `toPublicDigest()`.

### Deferred detector candidates (evidence recorded; awaiting greenlight)

These were observed but **not implemented** — fuzzier signal, higher false-positive risk, or
pending a design decision before touching the threshold knobs.

- **REPETITIVE_ORIENT / stagnant headline.** In-session forebrain headline collapses to the
  tautology `docked — docked` within ~3 ticks of plan start (7 of 11 FOREBRAIN events after t3).
  Proposed: flag N consecutive identical/near-identical forebrain headlines; threshold tunable
  (risk: genuinely static game states are real). Companion digest field: distinct-headline count /
  forebrain headline diversity. **Most important play-quality signal miss this run.**
- **WASTED_CYCLE / plan-never-executed.** Tick 1 produced `DECISION → STEP_SALVAGE → EVALUATE
  (failed → replan)` with no `STEP_START` between them — a plan was created but the step body
  expired on a 1-tick budget before opencode could launch (cold Docker/opencode body start). Proposed:
  flag a DECISION not followed by STEP_START before the next FOREBRAIN. Also surfaces a possible
  real bug: a step tick-budget of 1 is too tight for cold body starts.
- **Decision context poverty (semantic; hard to auto-detect).** Forebrain orient never surfaced
  kvothe's active mission chain (Crimson Resonance / Signal Propagation Survey / Parallel
  Installations — accepted missions with cargo loaded, all in `DIARY.md`); conscious chose
  mechanical "Refuel Ship" with no destination or mission rationale. Record as a prompt / orient-tuning
  observation rather than a detector.

### Carry-forward (re-confirmed open from prior retros)

- **SESSION_END is never emitted.** The enum value exists but nothing in the loop or orchestrator
  emits it → `terminalCause` can never report a clean end; end is only detectable via PROCESS_DIED.
  Emitting SESSION_END at graceful shutdown would complete the feature.
- **`classifyEvent` silent-swallows** `hindbrain:` non-escalate dispositions, `loop_start`, and
  `Entering phase:` — unchanged from run 2.
- **No tier cold-load latency detector.** `firstForebrainMs` ~183s went unflagged; the run digest
  has no per-tier health or latency fields.

### Operational / model decision for the human

- **Conscious-tier strategy.** Keep QwQ-32B-4bit (stable, clean decisions, fits warm alongside the
  other tiers), **or** restore the 122B on a dedicated warm port with a pre-warm call and longer
  per-call timeout. The 122B is not viable on the shared on-demand `:8083` umbrella server — it
  must be the sole large model resident on that port.
- **Character file gap.** `players/kvothe/me/background.md` and `VALUES.md` are unfilled
  boilerplate — all of kvothe's identity lives in `DIARY.md`. It's worth confirming whether the
  character pipeline actually reads `DIARY.md` in the orient/decide prompts; if not, coherence and
  values are not reaching the model.

**Status:** FATAL_ERROR + DEGRADED_TIER detectors and `terminalCause` digest field applied (TDD,
reviewed). Deferred candidates (REPETITIVE_ORIENT, WASTED_CYCLE, context-poverty observation)
queued. Carry-forward items and operational decisions remain open.

### Addendum — full run to clean shutdown (26 ticks)

A subsequent session ran to graceful SIGTERM after **26 ticks / ~30 min / 2 decisions**. Key
findings:

**Pre-warm is a worthwhile launch step.** Warming all 3 tiers before launch dropped
`firstForebrainMs` from ~183s (cold) to **~60s**, and `firstPlanMs` landed at **~103s — the
first run to ever reach a plan** (all 3 prior runs died before the conscious/plan phase). Add a
pre-warm step to the standard preflight.

**KEY FINDING — body step HUNG (most important play-quality miss).** `STEP_START` fired at tick
3; `STEP_DONE` was **never emitted**; fuel stayed frozen at 51% for the remaining ~22 ticks. A
WebSocket error at tick 4 (`Reconnect failed: Timed out waiting for welcome`) appears to have
stranded or lost the body process. The in-session loop never bounded the running step — no
timeout, no salvage, no replan — it continued emitting in-session FOREBRAIN orientations on a
frozen game state. The `docked — docked` forebrain headline collapse noted as REPETITIVE_ORIENT
above is the **symptom** of this stuck step, not an independent problem.

**Sharpens the WASTED_CYCLE candidate into two distinct patterns:**
- (a) **immediate salvage** — a DECISION whose step never starts (the tick-1 1-tick-budget expiry
  from this run)
- (b) **STUCK_STEP** — a `STEP_START` with no `STEP_DONE` within N ticks and no replan. Pattern
  (b) is the more severe failure and the **strongest detector candidate from this run.** It likely
  reflects a real bug: the in-session loop does not bound a running body step and does not recover
  when a WS reconnect failure strands the body. Recommend both a STUCK_STEP anomaly detector and a
  code investigation of in-session step lifecycle / WS-reconnect recovery.

**Operational hygiene gaps at shutdown:**
1. On graceful session SIGTERM, the session did **not** stop its Docker container — `roci-spacemolt`
   lingered "Up" after the session exited. Container teardown on graceful shutdown is incomplete.
2. The monitor did **not** self-finalise on session death via its `--session-pid` probe — needed an
   explicit kill before it wrote the digest. The PROCESS_DIED → finalise path may not be firing
   reliably. Both worth a look.

## 2026-06-22 (run 4) — kvothe/spacemolt (first live cold start of the ModelService layer)

First end-to-end run of PR1's `ModelService` (122B resident gate, per-phase swap). **FAILED** —
session wedged, **0 STEP_DONE**; digest `STALL×4, DEGRADED_TIER×2, PROCESS_DIED×1`,
`firstForebrainMs` 68s / `firstPlanMs` 120s. Full findings + remediation backlog:
`docs/superpowers/plans/2026-06-22-model-service-live-qa-findings.md`. Wreckage:
`players/kvothe/qa/wreck-20260622-001856/`.

**Two PR1 regressions found & fixed this session (TDD + review, committed `d6a2a2f`, `4b4b5e8`):**
the readiness gate did exactly **one** probe under `timeoutFail` (no poll loop → ms-fast false
failure on cold load; the per-tier `timeoutMs` was dead code) — now polls
`Effect.retry(Schedule.spaced("1s"))` bounded by the timeout, live-verified on the 2B (~2.3s spawn+poll
vs prior 26ms death); and the gated smoke could never have passed (no-spacing retry) and was never run
— rewritten through the real `acquireReady` path.

**HEADLINE — PR1 re-introduced the non-viable 122B via a divergent model config.** `model-tier-spec.ts`
(what ModelService spawns) disagrees with `handles.ts` `DEFAULT_CORTEX_MODELS` (what the cortex calls)
at **every tier**: 8081 spawns Qwen3.5-2B but the cortex requests Qwen2.5-7B-Instruct; 8082 spawns
Qwen3.5-9B vs Qwen2.5-32B-Instruct; **8083 spawns the 122B vs the cortex's QwQ-32B**. The
`makeTierSpec` guard asserts only port/baseUrl, **not model** — false "they agree." `mlx_lm.server`
serves whatever it loaded regardless of the requested name, so the cortex gets wrong models (→ `hindbrain:
undefined undefined`), and run-3's deliberate "drop the 122B for QwQ-32B" decision was silently reverted.
The 122B then died on 8083 mid-session exactly as run-3 predicted ("not viable on the shared pool").

### Misses → new detectors (`apps/roci/src/qa/feed.ts`)

- **TIER_UNREACHABLE / dependent-model-died — top miss this run.** The 122B (8083) went dead and the
  body hung on it indefinitely; the monitor saw only generic STALLs and `terminalCause` reported
  "process exited," never the real cause. Candidate: probe the tier ports the live loop depends on;
  if a depended-on tier is down (connection refused), fire a named anomaly (and feed `terminalCause`
  precedence above STALL). This is the model-lifecycle analogue of the run-3 FATAL_ERROR detector.
- **STUCK_STEP (re-confirmed from run-3 addendum).** `STEP_START` with no `STEP_DONE` within N ticks +
  frozen state + repetitive in-session forebrain. Directly reproduced. Strongest behavioural detector
  candidate still unbuilt; here the stuck step was caused by the dead conscious model, reinforcing the
  pairing with TIER_UNREACHABLE.

### False positives / chattiness

- **STALL fired 4× but could not distinguish "slow cold 122B" from "dead model."** Not a false
  positive exactly, but low-specificity: every failure mode this run collapsed to STALL. The fix is
  additive specificity (TIER_UNREACHABLE / STUCK_STEP), not a threshold change. `DEGRADED_TIER`
  (run-3 detector) fired correctly on the hindbrain garbage — working as intended.

### Digest blind spots → new field (`apps/roci/src/qa/digest.ts`)

- **`terminalCause` did not capture the real terminal cause.** Because the death was a *hang* on a dead
  model (no `Fatal error:` line, no early PROCESS_DIED — the session pid only died on my manual kill),
  the digest's `terminalCause` was the benign "process exited." Needs: a tier-health/last-reachable
  snapshot, and TIER_UNREACHABLE wired into the precedence so a wedged-on-dead-model run is
  distinguishable from a clean stop. Per-tier latency + which-tier-down still missing (carry-forward
  from run 3).

### Skill / playbook (this run)

- **Launch command corrected** (already partly in run-1 retro): `npx tsx apps/roci/src/main.ts …`
  fails — tsx is only under `apps/roci/node_modules`. Use `apps/roci/node_modules/.bin/tsx
  apps/roci/src/main.ts …` from repo root (cwd must be repo root so `process.cwd()` = projectRoot).
- **Log rotation before launch.** `events.jsonl` is append-mode (`log-writer.ts:45`); archive the prior
  run's events/qa-feed/monitor logs before starting so the monitor doesn't replay stale beats (the
  run-1 "monitor reads from offset 0" note). Done manually this run.
- SKILL.md already updated this session with the **mlx_lm.server venv/PATH** access section + corrected
  preflight (committed `4b4b5e8`).

### Carry-forward (still open)

- I2/shutdown hygiene now triples: SIGTERM leaves (1) the Docker container up, (2) the monitor not
  self-finalised, **and (3) spawned mlx tier servers leaked** (a 9B survived graceful TERM — Effect
  scoped finalizers don't run on the signal). All three want a real signal handler that interrupts the
  root fiber so finalizers + container stop run.
- SESSION_END still never emitted (run-3 carry-forward).

**Status:** **report-only run by user decision** — two readiness regressions fixed/committed; all
other findings (C0 config divergence, C1 probe hardening, C2 122B death root-cause, I1 body gate, I2
finalizer/shutdown, I3 topology, O1 mlx-stderr capture, O2/S1 detectors) **deferred** to the user with
the remediation sequence in the findings doc. No further code changes this session.
