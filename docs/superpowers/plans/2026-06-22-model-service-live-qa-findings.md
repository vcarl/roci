# ModelService PR1 — live cold-start QA findings & remediation backlog

**Date:** 2026-06-22 · **Character/domain:** kvothe / spacemolt · **Branch:** `model-service`
**Run type:** first live end-to-end cold start of the new ModelService layer (122B resident gate).
**Verdict:** ❌ **FAILED.** Session wedged; kvothe completed **zero** steps. `run-digest.json`:
`STALL×4, DEGRADED_TIER×2, PROCESS_DIED×1`, **0 STEP_DONE**. First forebrain 68 s, first plan 120 s,
then stalled until manual teardown.

Wreckage preserved at `players/kvothe/qa/wreck-20260622-001856/` (events, qa-feed, session.log,
monitor.stdout, run-digest).

---

## Fixed & committed this session (regressions in PR1, caught by QA)

1. **`fix(model-service): poll readiness with spaced retry bounded by tier timeout`** (`d6a2a2f`).
   `acquireReady` probed readiness exactly once under `Effect.timeoutFail` — no poll loop, so on a
   real cold load the gate failed in milliseconds and the per-tier `timeoutMs` (120/180/600 s) was
   dead code. Now polls `Effect.retry(Schedule.spaced("1 second"))` bounded by the timeout. Unit
   tests (TestClock) + the gated smoke rewritten to drive the real production path. **Live-verified:**
   the 2 B now spawns + polls ready in ~2.3 s (vs the prior 26 ms death), leak-clean.
2. **`docs(qa): document mlx_lm.server venv/PATH access`** (`4b4b5e8`). The harness spawns
   `mlx_lm.server` by bare name (no path override); it lives in the `~/llm-env` venv, not on global
   PATH. Documented activation / `PATH` prepend; corrected stale preflight.

These two were necessary and correct. **They were not sufficient** — the real 122B exposed the
deeper breaks below.

---

## HEADLINE ROOT CAUSE — divergent model config; PR1 silently re-introduced the abandoned 122B

PR1 added `packages/core/src/services/model-tier-spec.ts` as a **second source of truth** for tier
models, which **disagrees with the cortex's deliberately-tuned `packages/core/src/model/handles.ts`
(`DEFAULT_CORTEX_MODELS`) at every tier**:

| Port | ModelService **spawns** (`model-tier-spec.ts`) | Cortex/body **requests** (`handles.ts`) |
|---|---|---|
| 8081 hindbrain | `mlx-community/Qwen3.5-2B-4bit` | `mlx-community/Qwen2.5-7B-Instruct-4bit` |
| 8082 forebrain | `mlx-community/Qwen3.5-9B-4bit` | `mlx-community/Qwen2.5-32B-Instruct-4bit` |
| 8083 conscious | **`mlx-community/Qwen3.5-122B-A10B-4bit`** | `mlx-community/QwQ-32B-4bit` |

- The reconciliation guard `makeTierSpec` (`model-tier-spec.ts:26-32`) asserts only **port/baseUrl**
  agreement — **not the model name** — and its comment claims "ModelClient and ModelService agree."
  They do not. The check gives false confidence while every model silently diverges.
- `mlx_lm.server` serves whatever single model it loaded (`--model`), largely ignoring the request's
  `model` field. So the cortex *thinks* it is calling `Qwen2.5-7B-Instruct` on 8081 but actually
  gets the `Qwen3.5-2B` ModelService spawned — a smaller/different model → unparseable output →
  **`hindbrain: undefined undefined` (DEGRADED_TIER)**.
- Most importantly, **run 3 (2026-06-21) deliberately swapped conscious OFF the 122B to `QwQ-32B-4bit`**
  because *"the 122B is not viable on the shared 128 GB pool… it must be the sole large model resident"*
  (CALIBRATION.md, run 3 operational decision). PR1's `model-tier-spec.ts` **silently reverted that
  decision**, putting the 122B back on 8083 — and the live run reconfirms it still dies.

**This is the crux: PR1's value (managed lifecycle, gating) is real, but it hardcoded a model set that
contradicts the cortex and undid a prior, evidence-based model decision.** A stronger readiness probe
will not fix this — it would just make the loop correctly wait for a 122B that then dies anyway.

**Fix direction (deferred to the user):** one source of truth. Derive `TierSpec.model` *from*
`DEFAULT_CORTEX_MODELS[tier].model` (or vice-versa), and extend the `makeTierSpec` guard to assert
**model equality**, not just port. Then make a deliberate conscious-tier decision (QwQ-32B per run 3,
or a genuinely-isolated 122B) rather than letting two files drift.

---

## Findings (severity-ranked)

Legend: **NEW** = first seen this run · **RECONFIRM** = re-confirms a prior CALIBRATION finding.

| ID | Sev | Status | Finding |
|---|---|---|---|
| **C0** | Critical | NEW | **Divergent model config + 122B re-introduction** (headline above). `model-tier-spec.ts` vs `handles.ts`; port-only validator. Root of C2 and B1. |
| **C1** | Critical | NEW | **Readiness probe too weak → premature gate pass.** The `max_tokens:1` probe (`mlx-backend.ts:13-26`) is cheap enough that `mlx_lm.server` answers before the model can truly serve. The resident gate passed, the loop reached the conscious phase, and the body was dispatched while 8083 was not genuinely ready. ("ready before tick 1" violated.) *Inferred* — direct confirmation blocked by O1. |
| **C2** | Critical | NEW/RECONFIRM | **122B died mid-session → wedged, no detection, no recovery.** 8083 went dead; body `opencode -m local/conscious` hung indefinitely; cortex kept ticking on frozen state. Reconfirms run-3's "122B not viable" verdict. Cause unconfirmed (7 GB swap at peak ⇒ memory pressure/OOM likely; or load crash) — *cannot tell because mlx stderr is captured nowhere (O1)*. PR2 (supervised restart) is deferred, but there is not even **detection**. |
| **I1** | Important | NEW | **Body path ungated.** `opencode -m local/conscious` → `host.docker.internal:8083` (`conscious/opencode-config.ts:21-46`, provisioned `conscious-thought.ts:89`) is dispatched blind with no readiness check; hangs on a cold/dead model. |
| **I2** | Important | NEW/RECONFIRM | **Finalizer leak on shutdown.** Graceful SIGTERM exits in 2 s but a spawned 9 B server (port 8082) **survived** — Effect scoped finalizers did not run on the signal. (Run-3 addendum already flagged the container not stopping + monitor not self-finalizing; this adds: spawned mlx servers leak too.) |
| **I3** | Important | NEW | **Memory topology.** 122B (65 GB resident) + transient per-phase 9 B (~17 GB RSS observed) + body container drove **7 GB of 8 GB swap**. The "one light tier resident → ~66 GB peak" assumption is exceeded transiently and is a plausible C2 OOM trigger. |
| **I4** | Important | NEW | **No call-time readiness check on the resident tier.** `withTier(conscious)` is a no-op (`ModelService.ts:86-88`); the conscious call assumes 8083 is ready. Nothing re-verifies after layer build. |
| **I5** | Important | open (flagged earlier) | `readinessProbe` collapses **all** fetch errors into a non-timed-out `false` (`mlx-backend.ts:35-47`), so a genuine misconfig is indistinguishable from cold-loading and retries the full `timeoutMs`. |
| **O1** | Medium | NEW | **No mlx stdout/stderr capture.** `session.log` has zero model-lifecycle logging; when a tier dies there is no trail. This is the keystone — it both fixes observability and unblocks diagnosing C2. |
| **O2** | Medium | NEW/RECONFIRM | **Monitor has no "tier-unreachable/died" detector.** The dead 122B surfaced only as generic STALLs; `terminalCause` was just "process exited." A dependent-tier-down detector would have named the root cause. (Pairs with the run-3 addendum STUCK_STEP candidate.) |
| **B1** | Medium | RECONFIRM | **hindbrain emits `undefined undefined`** (DEGRADED_TIER, run-3 detector working). Now explained by C0 (model mismatch on 8081). |
| **S1** | — | RECONFIRM | **STUCK_STEP**: `STEP_START` with no `STEP_DONE`, frozen state, repetitive in-session forebrain — exactly the run-3 addendum pattern. The in-session loop does not bound a running body step. |
| **P1** | Process | NEW | Skill launch command `npx tsx apps/roci/src/main.ts …` fails (tsx only under `apps/roci/node_modules`). Correct: `apps/roci/node_modules/.bin/tsx …` from repo root. (Documented here; SKILL.md edit deferred per "no fixes.") |

---

## Recommended remediation sequence (when fixes resume)

1. **C0 first — reconcile model config to one source of truth** and make the conscious-tier decision
   explicitly. Nothing else is trustworthy while ModelService spawns different models than the cortex
   calls. Extend `makeTierSpec` to assert model equality.
2. **O1 — capture per-tier mlx stdout/stderr to log files.** Small, safe; turns C2 from inference into
   evidence. Re-run after this to actually *see* why 8083 dies (OOM vs crash).
3. Then, evidence in hand: **C1** (probe hardening: model-id match + real generation), **I1**
   (body-path readiness gate), **I2** (run finalizers on SIGTERM; stop container; kill spawned servers),
   **I3/topology** decision.
4. Detectors (QA dogfood): **O2** TIER_UNREACHABLE + **S1** STUCK_STEP (both already foreshadowed in
   CALIBRATION run 3). Treat with TDD + review per project discipline.

PR2 (bounded supervised restart) remains deferred and is now clearly load-bearing for C2 — but
detection (O2) and config sanity (C0) must precede it.
