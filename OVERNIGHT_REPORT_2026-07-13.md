# Overnight self-improvement loop — 2026-07-12/13

**Status: ended early at ~02:30 — monthly API spend limit hit** (the Phase 2 observer agent died mid-run; no further subagents could be spawned). Five iterations landed and were live-validated before the stop. Branch `feat/overnight-refinement`, **not merged** — merge awaits your review.

## Commits (each validated by the run after it)

| Commit | Iteration | What / why |
|---|---|---|
| `3e7dbb4` | 1 | Orient truncation cascade fix (maxTokens 1024→2048 + ~600-token output budget + truncated-JSON salvage) — run 1 showed one truncated orient blinding the whole session. Observability batch: body `tool_result` events, exchange `finishReason/maxTokens/truncated`, per-tick `interrupt_eval`, docker-exec argv+stderr capture. |
| `35df47d` | 2 | Hindbrain appraisal recalibration per Carl: discard = noise only, weight = salience (was 303/307 discard@0, danger-only; chat events were being discarded AND thereby excluded from long-term memory). |
| `4768572` | 3 | Ground-truth cognition: decide gets live domain state + "ground truth wins" rule; `applyGroundTruthMetrics` mechanically overwrites confabulated orient metrics; percent-rendered units. WebSocket self-heal: real teardown→redial→re-login with 1s→30s backoff (root cause: vendored client goes terminal on re-auth failure; domain re-polled a dead socket); staleness stamped into the summary; classifier emits structured system/location/docked. |
| `7a54dd5` | 4 | Appraisal middle ground after run 3 swung to 47/47 accumulate: mechanical event dedup (40-tick fingerprint window, chat exempt) + rubric repetition/anti-fabrication rules; orient prompt puts live state LAST (recency bias) with headline contract; percent bug root-caused (normalization skipped when ground metrics empty); WM plan titles prefixed `(assessment)`; appraisal events carry reason/summary/degraded. |
| `ac7d6b7` | 5 | Fingerprint deep-extracts salient nested state (system/poi/docked/combat, 10%-banded fuel/hull) — bridge run showed 6+ system jumps all deduped as "duplicate". Vendored client-v2 1.6.0 swapped in (see below), docker image rebuilt. |

## Measured improvements (baseline run 1 → bridge run / partial Phase 2)

- Orient parse failures: 1-of-1 catastrophic (truncated+discarded) → **0**; promptTokens 28k peak → **9k**.
- Orient grounding: 10/11 and 11/11 confabulated ("drifting in Horizon" while docked at First Step) → grounded headlines that frame the old storyline as past ("the earlier Phase Drift crisis... resolved"). Validated at low N — needs volume re-test.
- Appraisal: 303/307 discard@0 (danger-only) → 47/47 accumulate (flood) → **sane**: dedup killed 86/89 model calls, the one novel event accumulated w=2, zero fabricated threats.
- Hindbrain endpoint errors: 27% → **0%** in the last two runs.
- Fabricated decisions: run 2's invented fuel crisis (normalized 1.0 read as "1 unit") → decide explicitly rejects stale claims using the ground-truth block.
- Behavior: multi-session doom loop (re-deriving the CPU deficit) → **bought a Processing Core (1090cr), undocked, mined successfully, multi-system material sourcing for the CPU Co-Processor recipe, used system chat to ask players for materials**.
- CLI fumbling (Phase 2 partial, ~25 min): Did-you-mean=1, unexpected-argument=2, Unknown-command=1 total — vs earlier runs' repeated `Unknown command` → 3.7KB help-dump ratholes.

## Phase 2 deep run (partial — observer died at spend limit)

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
