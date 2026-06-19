# Cybernetics Phase 4b — Cortex Loop Rework (Conscious-Session Executor + Steering)

> **Status:** Design approved, pending spec review.
> **Date:** 2026-06-19
> **Branch:** `worktree-steering`
> **Builds on:**
> - Phase 4a — `docs/superpowers/specs/2026-06-19-cybernetics-phase4a-opencode-session-design.md` (the OpenCode conscious-session transport substrate this phase consumes).
> - Master design — `docs/superpowers/specs/2026-06-18-cybernetics-agent-sdk-steering-design.md` §5.4 (conscious tier as a tool-using OpenCode agent), §7 (steering: accumulate-and-push-on-a-cadence, coalescing), §8 (escalation as a sequential handoff).

## 1. Summary & Scope

Phase 4b reworks the cortex loop so the **conscious tier becomes the per-step executor**. Each plan step runs as a tool-using OpenCode conscious session — the local LLM is the brain doing the conscious work — instead of being forked to the frontier worker. The plan/step skeleton is **kept**; only the executor is swapped.

- The hindbrain and forebrain run **during** an active conscious session and feed cadence-throttled steering into it.
- The frontier worker (`cybernetics.delegate`) goes **dormant** in 4b. It is retained at the layer level for the 4c escalation path, but the loop no longer imports or calls it.

The conceptual model behind the service split (§2): the local LLM is the brain doing conscious thought, and frontier models are "cybernetic enhancements" reached only by escalation. Hence a new `ConsciousThought` service for the brain's own work, with `Cybernetics` left intact as the (dormant in 4b) escalation path.

## 2. Service Boundaries

### New service tag — `ConsciousThought`

Anatomically consistent with the existing hindbrain / forebrain / conscious vocabulary. It owns the conscious tier's provisioning and per-turn execution.

**Home: a new `packages/core/src/conscious/` folder, a peer to `cybernetics/`.** Conscious thought (the local brain's tool-using execution) and cybernetics (frontier escalation) are peer concepts, so they get peer folders — `cybernetics/` is not the right home for conscious thought. The 4a OpenCode config helpers (`opencode-config.ts`), which are conscious-agent concerns mis-homed in `cybernetics/` during 4a, **move into `conscious/`** as part of this phase (§9).

| Method | Signature | Behavior |
|---|---|---|
| `provision` | `provision({ containerId, char, handle, systemPrompt }) => Effect<void, never, …>` | Wraps the 4a `provisionConsciousProvider(containerId, handle)` (global per-container provider config) + `writeCharacterAgentFile({ playersDir, playerName, systemPrompt, modelLabel })` (project-local `.opencode/agent/conscious.md`, chmod read-only). Called **once** at loop startup. Inputs the two 4a helpers need are supplied by the loop, not re-derived inside the service: the resolved conscious `ModelHandle` (`resolveHandle(cortexModels, "conscious")`) and the character `systemPrompt` (`promptBuilder.systemPrompt(…)`). `playersDir` and `playerName` are derived from `char` — `char.dir` is `players/<name>/me/`, so `playersDir = path.resolve(char.dir, "../..")` and `playerName = char.name`; `modelLabel = CONSCIOUS_MODEL_LABEL`. No new `CortexLoopConfig` field is required. Result annotated `void` via `Effect.asVoid` (folds in the 4a follow-up). |
| `turn` | `turn(config, resume?) => Effect<{ result, sessionId }, never, …>` | Wraps the 4a `runOpenCodeSessionTurn`. `catchAll`-to-`never`: a failed turn becomes a `failed`-style result, never a thrown error — the same discipline `delegate` already applies. |

Layers:

- **`ConsciousThoughtLive`** — production; runs `provision` against Docker and `turn` over the shared transport.
- **`ConsciousThoughtTest`** — no-ops `provision`, returns canned `turn` results, and captures steer directives for assertions (mirrors `CyberneticsTest`'s `onSteer` capture).

### `Cybernetics` stays exactly as-is

`Cybernetics` retains its single `delegate` method (the frontier escalation path). In 4b it is **dormant**: the loop no longer imports or calls it. It is still composed at the app layer (`CyberneticsLive` remains in the application's layer graph) and is reintroduced into the loop in 4c.

### Requirement-channel change to `runCortex`

`runCortex`'s requirement channel **drops `Cybernetics`** and **adds `ConsciousThought`**. (4c re-adds `Cybernetics` when the escalation path is wired back in.)

## 3. Reworked Control Flow (the tick)

### Loop state

The 4b loop replaces the `delegationFiber` / `forkStep` machinery with conscious-session state:

```
consciousFiber   : Fiber<{ result, sessionId }, never> | null   // in-flight turn (was delegationFiber)
sessionId        : string | null    // current step's OpenCode session (null until turn 1 opens it)
stepReport       : string           // accumulated turn outputs for the current step
stepDoneSignaled : boolean          // agent emitted the completion marker
pendingDirective : string | null    // coalescing steering buffer (latest synthesis; newest wins)
lastSteerTick    : number           // cadence throttle
```

### Per-tick steps (deltas from today noted)

```
1. Drain world events → state.                                          (unchanged)

2. Classify + amygdala criticals.
   criticals → Fiber.interrupt(consciousFiber) → SIGKILL → return Interrupted.
                                                  (same path, new fiber name)

3. If consciousFiber in flight: poll.
   done → join → capture { result, sessionId }
        → set sessionId
        → append result.output to stepReport
        → set stepDoneSignaled = detectCompletion(result.output)
        → clear the fiber.
   Do NOT evaluate here.

4. HINDBRAIN triage — runs whenever there are events.
   The !delegationFiber gate is REMOVED so triage runs during an active
   session and can feed steering.

5. FOREBRAIN — two disjoint call sites split by currentPlan (never both):
   a. Idle (currentPlan === null): existing orient → decide → plan path.
      (gate removed but moot — there is no session when idle.)
   b. In-session (currentPlan !== null): on a NON-DISCARD hindbrain
      disposition, run forebrain → formatSteerDirective(orient)
      → store as pendingDirective (overwrite = coalesce, newest wins).

6. Step execution (replaces the forkStep / delegationFiber block) —
   when currentPlan !== null and no consciousFiber in flight:
   a. Evaluate now if stepDoneSignaled (agent flagged done)
      OR tick-budget elapsed (tick - stepStartTick >= step.timeoutTicks,
      worst-case salvage):
        → runConsciousEvaluate over stepReport
        → apply transition (next_step / replan / wait / terminate)
          exactly as today
        → reset sessionId / stepReport / stepStartTick / stepDoneSignaled
          for the next step.
   b. Else (not done, budget remains):
        - Turn 1 (sessionId === null):
            fork turn(cfg(step.task))          // opens the session
        - Steer turn (tick - lastSteerTick >= DEFAULT_STEER_CADENCE_TICKS
          && pendingDirective !== null):
            fork turn(cfg(pendingDirective), { sessionId })
            clear pendingDirective; set lastSteerTick.
        - Otherwise idle (session stays open; the agent already exited
          its last turn).

7. Sleep one tick.                                                      (unchanged)
```

### Key inversion

The **turn** fiber is forked, polled, and interrupted exactly like today's step fiber. The difference is that step boundaries are now **completion-signal-driven** (with the tick-budget as a backstop), and between turns the loop launches **steered re-invocations** of the same OpenCode session.

## 4. Steering (forebrain → directive → next turn)

This implements the master design §7 "accumulate, push on a cadence" model over the 4a re-invoke-per-turn transport.

### Mechanism

- Each tick during a session, the hindbrain triages. A **non-discard** disposition wakes the forebrain (master §5.4), whose synthesis is rendered to directive text and stored in `pendingDirective`.
- **Overwrite-on-store is the capacity-1 coalescing.** A newer directive fully supersedes an unconsumed older one — newest wins. No `Queue` is needed because the cortex loop is a single-fiber sequential loop.
- A steer turn launches **at most once every `DEFAULT_STEER_CADENCE_TICKS`** (= 3). On a steer tick the latest `pendingDirective` becomes the next turn's prompt via `turn(cfg(directive), { sessionId })`, and the buffer clears.

### What 4b does NOT use from Phase 3

The Phase-3 SDK steering machinery — the coalescing `Queue.sliding(1)` (`makeSteeringQueue`), `buildSteeredStdinStream`, and `runSdkSession` — is **not** used by 4b. It stays reserved for the 4c SDK escalation session (a live generator). 4b consumes only the Phase-3 `Directive` type and the `DEFAULT_STEER_CADENCE_TICKS` constant.

### `formatSteerDirective` (new pure formatter)

A new pure formatter in `state.ts`, sibling to `formatStepTask`. It renders the forebrain `OrientResult` (headline + whatChanged + sections) into a concise directive. The output is **laundered** — model-generated, never raw inbound text — which preserves the master design's Vector-A laundering guarantee (§3).

## 5. Provisioning, Lifecycle & Model Selection

### Provisioning

Provisioning runs **once** before the loop's first tick:

```
const handle = resolveHandle(runnerConfig.models, "conscious")
const systemPrompt = promptBuilder.systemPrompt("select", "")
yield* consciousThought.provision({ containerId: config.containerId, char: config.char, handle, systemPrompt })
```

- The global provider config is per-container and idempotent (safe across characters sharing one container).
- The per-character agent file is chmod read-only (4a config-protection).
- `playersDir`/`playerName` are derived inside `provision` from `char` (`char.dir` → grandparent `players/`, `char.name`); no host-path field is added to `CortexLoopConfig`.

### Model selection

The conscious session always runs the local conscious agent, via the 4a stable-id constants:

- `agentName: "conscious"`
- model label `local/conscious`
- `runtime: "opencode"`

`step.tier` (fast / smart) becomes **execution-irrelevant** in 4b: it formerly selected a frontier tier, but the conscious agent is a single local model. `tier` is retained on `PlanStep` untouched — 4c uses it for escalation model selection.

### Per-turn timeout

Each `turn` gets the transport wall-clock timeout. 4b reuses `workerTimeoutMs` as the **per-turn** bound (a comment should clarify the loop's intent here, since it formerly bounded a whole step). The **per-step** bound is `timeoutTicks × tickMs`. A dedicated `consciousTurnTimeoutMs` knob is deferred tuning, not 4b.

## 6. Completion Model

Completion is **signal-driven with a budget backstop**.

- The agent emits a recognizable completion marker when it judges the task done. The task framing instructs this: extend the existing `formatStepTask` "report whether the success condition is met" instruction into a structured marker.
- 4b ships the **mechanism**: a marker constant plus a pure `detectCompletion(output): boolean` in `state.ts` (unit-tested).
- `runConsciousEvaluate` stays the **arbiter**. A done-flag triggers evaluation early but is **not** trusted as ground truth — evaluate judges the self-reported completion against `successCondition` (a premature done-flag → `replan` / `wait`; a real one → `next_step`).
- The step's `timeoutTicks` is the worst-case **salvage** backstop, not a minimum dwell.

Deferred to 4c: completion-marker phrasing / robustness tuning (master §11) and the separate escalation-request marker.

## 7. Error Handling & Kill

- **Turn failure** (auth, container, missing session id): `turn` maps to a `failed` result (`output` = the message). The loop appends it to `stepReport` and continues; the step still evaluates (at done-flag or budget). No throw escapes.
- **Kill** (criticals): `Fiber.interrupt(consciousFiber)` → the transport SIGKILLs the in-container process tree. This hard path is unchanged.

## 8. Testing

### Loop tests (`packages/core/src/cortex/loop.test.ts`, via `ConsciousThoughtTest`)

- Turn 1 opens a session.
- A done-marker triggers an early evaluate.
- Tick-budget triggers a salvage evaluate.
- A non-discard hindbrain disposition → forebrain → directive stored.
- The cadence throttle launches a steer turn carrying the latest (coalesced) directive.
- Criticals interrupt mid-turn → `Interrupted`.
- A multi-step plan advances `next_step` across sessions.
- Directive text is laundered (asserted via the captured `onSteer` hook).

### Pure-unit tests (`state.ts`; no I/O)

- `detectCompletion` unit test.
- `formatSteerDirective` unit test.

### Service test

- `ConsciousThoughtTest` captures directives.
- A `turn` failure → `failed` result.

### Container / smoke

No new container or smoke work in 4b beyond 4a's gated smoke. A steered-session smoke step lands with 4c.

## 9. Files Touched

| File | Change |
|---|---|
| `packages/core/src/conscious/conscious-thought.ts` | **New module** (peer to `cybernetics/`). The `ConsciousThought` tag + `ConsciousThoughtLive` / `ConsciousThoughtTest` layers, and the conscious-turn config type (here or in a sibling `conscious/types.ts`). |
| `packages/core/src/conscious/opencode-config.ts` | **Moved** from `packages/core/src/cybernetics/opencode-config.ts` (a conscious-thought concern, not escalation). Its tests `opencode-config.test.ts` and `opencode-session.smoke.test.ts` move with it; their `./opencode-config.js` imports stay relative and need no change. |
| `packages/core/src/core/limbic/hypothalamus/payload.ts` | Update the lone external importer: `CONSCIOUS_AGENT_NAME` import path `../../../cybernetics/opencode-config.js` → `../../../conscious/opencode-config.js`. |
| `packages/core/src/cybernetics/delegate.ts` | **Untouched** — `Cybernetics` stays exactly as-is (dormant in 4b). Listed to make the no-change explicit; the new service does **not** go here. |
| `packages/core/src/cortex/loop.ts` | The rework: new state vars, remove the four `!delegationFiber` gates, the step-execution block, the provisioning call, and the requirement-channel swap (drop `Cybernetics`, add `ConsciousThought`). |
| `packages/core/src/cortex/state.ts` | `formatSteerDirective`, `detectCompletion`, the marker constant, and the task-framing marker instruction. |
| Tests | `loop.test.ts`, `state.test.ts` (or sibling), and a `conscious/` service test for `ConsciousThought`. |

## 10. Scope Boundary (explicitly 4c, NOT 4b)

- Frontier escalation (validate / rescue handoff).
- Auto-escalation triggers.
- Completion-marker robustness / tuning, and the escalation-request marker.
- Re-wiring `delegate` / `Cybernetics` back into the loop.
- The SDK live-generator steering path (`buildSteeredStdinStream` / `runSdkSession` / the Phase-3 `Queue`).

## 11. Carried 4a Follow-ups Folded into 4b

1. `provision` annotated `Effect<void>` via `Effect.asVoid`.
2. First-wins-overwrite + shell-special-char round-trip tests (deferred from 4a).
3. A typed "session-not-found on resume" error — surfaced now, since 4b is the first real resume caller.

## 12. Code Reference Verification

Verified against the codebase on 2026-06-19. References below were confirmed present unless explicitly noted as a new addition (not a broken reference).

- `runCortex`, the four `!delegationFiber` gates, `forkStep`, `delegationFiber`, `DEFAULT_TICK_MS` (30_000), `DEFAULT_ORIENT_INTERVAL` (5), `DEFAULT_WORKER_TIMEOUT_MS` (60 min), and `DEFAULT_STEER_CADENCE_TICKS` (3, exported, currently unconsumed) — `packages/core/src/cortex/loop.ts`. ✓ (`!delegationFiber` gates confirmed at the hindbrain triage `loop.ts:232`, the force-orient check `loop.ts:243`, the forebrain/decide site `loop.ts:247`, and the step-fork site `loop.ts:285`. `runCortex` imports `Cybernetics` at `loop.ts:12` and lists it in the requirement channel at `loop.ts:305`.)
- `runConsciousDecide`, `runConsciousEvaluate`, `runHindbrain`, `runForebrain`, and the hindbrain `disposition` default `accumulate` on parse failure (`tiers.ts:73`) — `packages/core/src/cortex/tiers.ts`. ✓
- `OrientResult` shape (`headline`, `whatChanged`, `sections`) consumed by the new `formatSteerDirective` — confirmed in `tiers.ts` (`headline`/`whatChanged`/`sections` at `tiers.ts:102–104`). ✓
- `formatStepTask` (and its "report concisely … whether the success condition is met" instruction) and `formatExecutionReport` — `packages/core/src/cortex/state.ts` (`formatStepTask` at `state.ts:35`, instruction at `state.ts:41`). ✓
- `formatSteerDirective` and `detectCompletion` (plus the completion-marker constant) — **new additions** to `packages/core/src/cortex/state.ts`. Confirmed absent today (not a broken reference).
- `runOpenCodeSessionTurn(config, resume?: { sessionId })` returning `Effect<{ result: TurnResult; sessionId: string }, ClaudeError, …>` — `packages/core/src/core/limbic/hypothalamus/process-runner.ts` (`runOpenCodeSessionTurn` at `process-runner.ts:153`; first turn captures `sessionID`, resume continues via `-s <id>`; fails with `ClaudeError` when no session id is captured). ✓
- `TurnConfig` (`agentName?` at `types.ts:29`, `prompt`) and `TurnResult` (`output`, `timedOut`, `durationMs`, `sessionId?`) — `packages/core/src/core/limbic/hypothalamus/types.ts`. ✓
- `provisionConsciousProvider` (writes the global per-container provider config) and `writeCharacterAgentFile` (writes the project-local `.opencode/agent/conscious.md`, chmod read-only) plus the stable ids `CONSCIOUS_PROVIDER_ID = "local"`, `CONSCIOUS_MODEL_KEY = "conscious"`, `CONSCIOUS_MODEL_LABEL = "local/conscious"`, `CONSCIOUS_AGENT_NAME = "conscious"` — currently `packages/core/src/cybernetics/opencode-config.ts`, **moved to `packages/core/src/conscious/opencode-config.ts` in 4b** (§9). ✓ Importers confirmed: its own two tests (relative imports) and `CONSCIOUS_AGENT_NAME` in `packages/core/src/core/limbic/hypothalamus/payload.ts:8` (the one path to rewire).
- `Cybernetics` tag exposing only `delegate(config, steering?)`, `CyberneticsLive`, and `CyberneticsTest` (with its `onSteer` capture hook) — `packages/core/src/cybernetics/delegate.ts`. ✓
- `ConsciousThought` tag + `ConsciousThoughtLive` / `ConsciousThoughtTest` layers — **new additions** in the new `packages/core/src/conscious/` folder (not a broken reference).
- `Directive { text }` type, `makeSteeringQueue` (coalescing `Queue.sliding(1)`), `buildSteeredStdinStream`, and `runSdkSession` (Phase-3, reserved for 4c) — `Directive` at `packages/core/src/cybernetics/types.ts:41`; `buildSteeredStdinStream` imported from `cybernetics/steering.js`; `runSdkSession` exported from `process-runner.ts:136`. ✓
- `PlanStep` (`task`, `goal`, `tier: "fast" | "smart"`, `successCondition`, `timeoutTicks`) — `packages/core/src/core/types.ts:15`. ✓
- `loop.test.ts` and `CyberneticsTest` usage — `packages/core/src/cortex/loop.test.ts`. ✓
