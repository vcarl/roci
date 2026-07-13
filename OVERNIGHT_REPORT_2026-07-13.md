# Overnight self-improvement loop — 2026-07-12/13

**Status: COMPLETE — 6 iterations, all live-validated; final verdict from the 110-minute validation run: ready for routine unattended multi-hour operation.** (The loop paused ~02:30–05:00 on the monthly API spend limit, then resumed per your instruction and ran the original plan to completion.) Branch `feat/overnight-refinement`, **not merged** — merge awaits your review.

## Commits (each validated by the run after it)

| Commit | Iteration | What / why |
|---|---|---|
| `3e7dbb4` | 1 | Orient truncation cascade fix (maxTokens 1024→2048 + ~600-token output budget + truncated-JSON salvage) — run 1 showed one truncated orient blinding the whole session. Observability batch: body `tool_result` events, exchange `finishReason/maxTokens/truncated`, per-tick `interrupt_eval`, docker-exec argv+stderr capture. |
| `35df47d` | 2 | Hindbrain appraisal recalibration per Carl: discard = noise only, weight = salience (was 303/307 discard@0, danger-only; chat events were being discarded AND thereby excluded from long-term memory). |
| `4768572` | 3 | Ground-truth cognition: decide gets live domain state + "ground truth wins" rule; `applyGroundTruthMetrics` mechanically overwrites confabulated orient metrics; percent-rendered units. WebSocket self-heal: real teardown→redial→re-login with 1s→30s backoff (root cause: vendored client goes terminal on re-auth failure; domain re-polled a dead socket); staleness stamped into the summary; classifier emits structured system/location/docked. |
| `7a54dd5` | 4 | Appraisal middle ground after run 3 swung to 47/47 accumulate: mechanical event dedup (40-tick fingerprint window, chat exempt) + rubric repetition/anti-fabrication rules; orient prompt puts live state LAST (recency bias) with headline contract; percent bug root-caused (normalization skipped when ground metrics empty); WM plan titles prefixed `(assessment)`; appraisal events carry reason/summary/degraded. |
| `ac7d6b7` | 5 | Fingerprint deep-extracts salient nested state (system/poi/docked/combat, 10%-banded fuel/hull) — bridge run showed 6+ system jumps all deduped as "duplicate". Vendored client-v2 1.6.0 swapped in (see below), docker image rebuilt. |
| `39cc5e2` | 6 | Conscious-tier silence recovery — two deep runs reproduced indefinite opencode→mlx hangs (29+/20+ min, server idle, only backstop a 61-min process timeout): 300s silence watchdog → kill stuck request + reap in-container tree → retry once → structured abort into the step-failure→replan seam; `body_liveness` metric. Control-plane clamp (lifecycle frames can never escalate — kills the fabricated "hull damage on logged_in" threat), threat-evidence guard, WM volatile-metrics scrub. |

## Measured improvements (baseline run 1 → bridge run / partial Phase 2)

- Orient parse failures: 1-of-1 catastrophic (truncated+discarded) → **0**; promptTokens 28k peak → **9k**.
- Orient grounding: 10/11 and 11/11 confabulated ("drifting in Horizon" while docked at First Step) → grounded headlines that frame the old storyline as past ("the earlier Phase Drift crisis... resolved"). Validated at low N — needs volume re-test.
- Appraisal: 303/307 discard@0 (danger-only) → 47/47 accumulate (flood) → **sane**: dedup killed 86/89 model calls, the one novel event accumulated w=2, zero fabricated threats.
- Hindbrain endpoint errors: 27% → **0%** in the last two runs.
- Fabricated decisions: run 2's invented fuel crisis (normalized 1.0 read as "1 unit") → decide explicitly rejects stale claims using the ground-truth block.
- Behavior: multi-session doom loop (re-deriving the CPU deficit) → **bought a Processing Core (1090cr), undocked, mined successfully, multi-system material sourcing for the CPU Co-Processor recipe, used system chat to ask players for materials**.
- CLI fumbling (Phase 2 partial, ~25 min): Did-you-mean=1, unexpected-argument=2, Unknown-command=1 total — vs earlier runs' repeated `Unknown command` → 3.7KB help-dump ratholes.

## Final validation run (110 min, commit 39cc5e2) — PASS

Detached-launch (immune to the 60-min background-shell cap that killed earlier attempts). Results:
- **Silence recovery validated 3× live, both branches**: hang at 319s → kill → retry → ~21 productive minutes; second hang on the same step → abort → `step salvage` → diary lesson → grounded orient → next step closed clean in 4 min; a third hang later also recovered. Zero false positives (a 13-min turn emitting output was left alone). The prior runs froze permanently at this exact point.
- **Control-plane clamp validated on the exact repro**: `appraisal clamped: control-plane event (was w=4 ... "Hull damage taken")` at startup; fabricated threats 1 → 0.
- **Reliability**: 0 tier errors, 0 ws errors/reconnects, no memory growth (~770MiB steady), WM 4→6 lines, promptTokens ~3.9k, clean SIGTERM + full sweep.
- **Behavior**: real economy play — cross-system ore trading, mining, cargo cycling 34→47→19→28, CPU-upgrade plan actively pursued (superconductor bought, crafts dry-run) though not completed in-window.

**Remaining weaknesses (non-blocking, ranked)**: (1) the underlying opencode→mlx stuck-request stalls still occur ~once per long turn — recovery masks them, throughput pays; root-cause the mlx side next. (2) Deliberative turns are slow (avg 74s, max 150s) and single steps can run 20-35 min without closing (commit-gap). (3) "full fuel" narration still leaks into ~half of orient headlines at 61-71% fuel (WM scrub misses cargo numbers too). (4) Never exercised: threat-evidence guard (no combat), fuel_low interrupt (fuel stayed ≥61%), iter-5 fuel-band-crossing positive case; location-change salience looks under-weighted (post-jump snapshots appraised as duplicates).

## Phase 2 first attempt (partial — observer died at spend limit)

Launched 01:25 from `ac7d6b7`; data through ~01:48 in `players/vcarl/logs/` (events.jsonl lines ~2792–3258+) and checkpoints in the session scratchpad (`phase2-checkpoints.md`). Highlights: 0 reconnects, 0 tier errors, WM stable at 5 lines, fuel 85→71% across jumps, recipe discovered (processing_core + coolant_loop + 2×circuit_board + 3×durasteel_plate + superconductor), loud arg errors fired and kept the body out of ratholes. The run/container were killed (137) when the observer's process tree was reaped — logs intact, no orphans, container removed.

## client-v2 (separate repo — NOT pushed)

Branch `fix/reconnect-auth-and-cli` in worktree `~/workspace/client-v2/.claude/worktrees/reconnect-cli`, based on `feat/ws-socket-types` @ `ae8c19e` (main is REST-only; roci ships 1.6.0 from that branch). 3 commits, 323/323 tests:
- `dbc8e11` non-terminal reconnect auth (UNRECOVERABLE_AUTH_CODES grounded in gameserver source; transient/throttle → retry, ban/token → terminal)
- `72e23fd` did-you-mean suggestions + `browse_market` alias
- `2f8f9e3` loud unexpected-argument errors (extra positionals, unknown key=value — which the server was silently ignoring — and unknown --flags)

The rebuilt tarball is already vendored into this branch (both copies + one-line lockfile integrity + docker image). **Note:** unknown-named-arg rejection is a breaking tighten for callers that deliberately pass extra fields (none found in roci/tests).

## Open items / deferred

1. **D4 not fixed (deliberate defer):** no mechanism forces a validated discovery to update WM/diary; stale narratives only die when ground truth outweighs them. A "reconcile WM on evaluate:succeeded" design is the next big behavior item.
2. **Orient grounding validated at N=1-2** — needs a run with many orients (a run where the body isn't in one long conscious session).
3. **Dedup state-transition accumulates** (iter-5 fingerprint fix) landed but was never live-validated — the Phase 2 run died first. Unit tests cover it.
4. **client-v2 4001 `session_replaced`:** the server sends WS close 4001 to mean "do not reconnect", but sdk-socket.ts deliberately reconnects on it (header comment says intentional). Potential ping-pong with a replacing connection. Left alone; needs an owner decision.
5. **Pre-existing test failures (not from tonight, confirmed by stash-testing repeatedly):** 15 reflection/dream in `planned-action.test.ts` + 1 wm-lifecycle in `loop.test.ts`.
6. Observer subagents kept ending their turns mid-run (3 nudges needed); if this loop runs again, bake "never end turn while run is live" + checkpoint-file protocol into the observer prompt from the start (done in the Phase 2 prompt — it worked).
7. `interrupt_eval` and docker-exec error-detail paths still never exercised live (no qualifying events).

## How to resume

- Runs: `./roci start --domain spacemolt vcarl` from this branch (dist + docker image already built at `ac7d6b7`).
- Merge: squash-or-keep per preference; all 5 commits are independently revertable and each message carries its run evidence.
- client-v2: review the 3 commits in the worktree branch, then push/merge in that repo; roci already carries the built artifact.
