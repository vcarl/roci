# Design: ModelService — Effect-managed model-server lifecycle

**Date:** 2026-06-21
**Branch:** `model-service` (forked from `roci-qa-copilot`@`60960cf`, which carries the transport
retry/backoff work the probe/crash paths build on)
**Status:** approved (design); proceeding to implementation plan.

## Problem

The three cortex tiers are served by manually-started `mlx_lm.server` processes, each an
"on-demand umbrella" exposing ~29 models and cold-loading on first use of any of them.
QA found this fatal: `/v1/models` returns 200 *before* weights are resident, so a session
starts against an unready model and the first conscious call dies (`Model call failed …
endpoint unreachable?`). Every session this period crashed at tick 0 this way; the heavyweight
122B conscious model in particular lost the cold-load race / contended for memory and OOM-died.

## Goals

1. **Hard readiness guarantee** before tick 1 — a tier is "ready" only when it can actually
   generate, not when an HTTP listener exists.
2. **Deterministic startup sequencing & memory control** via Effect scoped layers, so the
   expensive conscious model is never raced or evicted.
3. **Single-command startup** — `roci start` owns the model servers; no manual pre-launch.
4. **Survive the mid-session crash** we observed (bounded supervised restart — PR2).

## Locked decisions (from the prior decisions doc + this session's brainstorm)

- **Full lifecycle ownership** with **adopt-if-healthy** and **don't-kill-what-you-didn't-spawn**:
  track `spawned: boolean` per process; finalizers kill only what this session started; if a
  healthy server already answers a tier's port+model, attach instead of respawning.
- **Topology — pin the heavyweight, swap the light tiers:**
  - **conscious** = `mlx-community/Qwen3.5-122B-A10B-4bit` (~57–60 GB), `lifecycle: "resident"`,
    on port `8083`. Acquired **first** and held for the whole session scope; gated on its
    readiness probe before any other tier loads, so it never races a cold-load.
  - **forebrain** (information synthesis & discovery) = `mlx-community/Qwen3.5-9B-4bit`
    (~5.6 GB), `lifecycle: "per-phase"`, port `8082`.
  - **hindbrain** (limbic, largely non-verbal triage) = `mlx-community/Qwen3.5-2B-4bit`
    (~1.6 GB), `lifecycle: "per-phase"`, port `8081`.
  - All three model files are already present in the local HF cache — no downloads.
- **Per-phase swap** for the light tiers: load when entering the tier's phase, unload right
  after. With a 2B/9B these spawn+load in seconds (vs ~45 s for the old 32B), so per-phase
  churn is cheap. The `lifecycle` field is per-tier config, so any tier can be flipped to
  `resident` or (future) `keep-warm` without redesign.
- **Readiness gate = 1-token generate probe** (a real `/v1/chat/completions` with
  `max_tokens: 1`), NOT `/v1/models`. Per-tier `timeoutMs`; timeout on any required tier →
  fail the session loudly with a structured error. All three tiers are required.
- **Crash policy = bounded supervised restart** (target), shipped in two steps (see Scope).
- **Pluggable backend**: a typed `ModelBackend` interface; `mlx_lm.server` is the first impl;
  other OpenAI-compatible backends (llama.cpp, …) addable without changing the ModelService
  contract.

## Architecture

New file `packages/core/src/services/ModelService.ts`, exposed as `ModelServiceLive` and added
to the `serviceLayer` in `apps/roci/src/cli.ts`. Follows the repo idiom: `Context.Tag` for the
service interface, but constructed with **`Layer.scoped`** (a new pattern here — the codebase
already uses `Scope.addFinalizer` in `game-socket-impl.ts` and `Effect.scoped` in `Docker.ts`,
so the vocabulary exists).

### Components & boundaries

- **`ModelBackend`** (interface): `spawn(spec) → Effect<RunningServer, SpawnError, Scope>`,
  `readinessProbe(spec) → Effect<void, ReadinessError>`, `kill(handle) → Effect<void>`,
  `isHealthy(spec) → Effect<boolean>` (for adopt-if-healthy). One impl: `MlxBackend`
  (spawns `mlx_lm.server --model <id> --port <p> <spawnArgs…>`).
  *Boundary:* knows how to run/probe/stop one server; knows nothing about tiers or the loop.
- **`TierSpec`** (data): `{ tier, backend, model, port, spawnArgs, readinessProbe, timeoutMs,
  lifecycle }`. Extends/derives from today's `DEFAULT_CORTEX_MODELS` in `handles.ts` so there
  is one source of truth for tier→model→port.
- **`ModelService`** (the tag/interface): the loop-facing API.
  - `withTier(tier)(effect)` — scoped acquire/use/release. For a `resident` tier it's a no-op
    (already held). For a `per-phase` tier it ensures the server is spawned + probed-ready,
    runs `effect`, and kills the server on scope close (guaranteed even on failure/interrupt).
  - The resident tier(s) are acquired by the layer's own scope at startup, gated in order.
  *Boundary:* owns the set of running servers and their lifecycle; depends only on `ModelBackend`
  + the tier specs. The loop calls `withTier`; it never touches processes directly.

### Lifecycle & sequencing (the core guarantee)

- **Layer scope (startup):** `Layer.scoped` builds the service by `acquireRelease`-ing the
  `resident` conscious server **first** and probing it ready before returning. The layer does
  not become available to the rest of `serviceLayer` until the 122B answers a generate probe.
  This is the hard "ready before tick 1" gate, expressed as layer-acquisition order.
- **Per-phase (runtime):** `callTier(tier)` in `cortex/tiers.ts` is wrapped so its HTTP call
  runs inside `ModelService.withTier(tier)(…)`. Acquire = spawn+probe; release = kill. Only one
  light tier is ever resident at a time, so peak memory ≈ 60 GB (122B) + 5.6 GB (9B) ≈ ~66 GB
  on the 128 GB box.
- **Teardown:** the layer scope closes when `roci start` exits. Finalizers kill every
  `spawned` server (and skip adopted ones). The plan must verify `NodeRuntime.runMain` runs the
  scope's finalizers on SIGINT/SIGTERM, not only on clean return.

### Error handling

- `SpawnError`, `ReadinessError` (incl. timeout), `ModelCrashed` — structured, typed errors in
  the Effect error channel. A required-tier readiness failure at startup fails the whole layer
  (session never starts) with a clear message. A mid-session `withTier` acquire failure surfaces
  to the loop as a typed error (PR1: fail-fast; PR2: after bounded restart exhausted).
- **Adopt-if-healthy** uses `isHealthy` (a generate probe against the expected port+model); on
  success the spec is marked `spawned: false` so teardown leaves it running.

## Config & integration

- Per-tier specs live in code, co-located with / derived from `DEFAULT_CORTEX_MODELS`
  (`packages/core/src/model/handles.ts`), extended with `spawnArgs`, `readinessProbe`,
  `timeoutMs`, `lifecycle`. The existing `ModelClient`/`callTier` URL resolution
  (`handle.baseUrl` → port) is unchanged; ModelService sits beside `ModelClientLive` and
  guarantees the server behind that URL is up.
- `.roci` JSON / CLI overlay for these new fields is **deferred** (YAGNI for PR1).
- The lingering `roci-spacemolt` Docker container is the **Docker service's** concern — out of
  scope here.

## Testing strategy

- A **`FakeBackend`** with scripted behavior (spawn delay, probe success/timeout, crash-on-Nth-
  call) lets us unit-test all lifecycle/sequencing/teardown/restart logic deterministically with
  **no real processes** — using `Effect.runPromise` + a `TestClock` for timeouts/backoff.
- Assert: resident-first ordering; readiness gate blocks until probe passes; required-tier
  timeout fails the layer; `withTier` releases (kills) on success AND on failure/interrupt;
  adopt-if-healthy leaves a pre-existing server running; (PR2) restart retries N times then
  fails.
- **One gated integration smoke** (behind an env flag, not in the default suite) that spawns a
  *real* small server (`Qwen3.5-2B`) through `MlxBackend`, probes it, and tears it down — proves
  the real spawn/probe/kill path. Mirrors `docs/cortex-smoke.md`'s existing opt-in smoke posture.

## Scope / PR breakdown

- **PR1 (this build):** `ModelBackend` + `MlxBackend`, `TierSpec`, `ModelService`
  (`Layer.scoped`) with resident-conscious gated startup, per-phase `withTier`, the generate
  readiness probe, adopt-if-healthy, clean scoped teardown, wired into `roci start`. **Fail-fast**
  on mid-session crash (typed `ModelCrashed` to the loop). Full TDD with `FakeBackend`; gated
  real smoke.
- **PR2 (fast-follow):** bounded supervised restart (Effect retry/supervision with a cap) for
  `withTier` acquire and for the resident tier.

## Out of scope / deferred

- `.roci`/CLI config overlay for spawn fields; `keep-warm` lifecycle policy (field reserved).
- Docker container reaping; multi-backend beyond mlx; per-tier latency/health metrics in the
  run-digest (candidate for the QA digest work).
