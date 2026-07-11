# The Cortex (Conscious Layer) & the `brain/loop` Engine

**Vocabulary note (read this first).** "Cortex" now names the **conscious /
deliberative layer only** — `packages/core/src/brain/cortex/conscious/`, the ~31B tier
that decides, evaluates, and executes tool-using work. The **tick engine** that conducts
the whole brain is `runCortex`, and it lives in `packages/core/src/brain/loop/` — it is
*not* itself "the cortex." Older docs used "the cortex loop" to mean the whole engine;
that framing is retired. This document is the reference for both the loop engine and the
conscious layer it drives.

For the surrounding mental model (the reflexive → integrative → deliberative depth
hierarchy and the layering invariants) see [../packages/core/src/brain/BRAIN.md](../packages/core/src/brain/BRAIN.md);
for the pre-conscious limbic layer see
[LIMBIC.md](../packages/core/src/brain/limbic/LIMBIC.md); for the OODA skill templates the
tiers render see [OPERATING_SKILLS.md](OPERATING_SKILLS.md).

## 1. What the loop is

`runCortex(config)` is exported from `packages/core/src/brain/loop/loop.ts` and
re-exported from the package barrel at `packages/core/src/index.ts`. It runs once per
character: each domain calls it from the `active` phase (`domain-spacemolt/src/phases.ts`
and `domain-github/src/phases.ts`, both importing it from `@roci/core/brain/loop/loop.js`).

The loop is an infinite `while (true)` tick loop. World events do not stream into a
running CLI session; they arrive on an Effect `Queue`
(`CortexLoopConfig.events: Queue.Queue<unknown>`) that each tick drains non-blocking. The
loop owns cognition (appraise → orient → decide → execute → evaluate); the actual
tool-using work happens in a separate OpenCode session the conscious layer forks and
resumes (see §7).

`CortexLoopConfig` carries: `char`, `containerId`, `containerEnv`, `addDirs`, `events`,
`initialState`, `cadence`, `cortexModels`, `workerModels`, `orientInterval`,
`workerTimeoutMs`, `tickIntervalMs`. The loop returns a `CortexResult`: `Completed` (with
`finalState`) or `Interrupted` (with `finalState` + `criticals`).

## 2. The three tiers

Cognition is split across three model tiers — `hindbrain`, `forebrain`, `conscious` —
defined as `CortexTier` (`model/handles.ts`) and configured by `DEFAULT_CORTEX_MODELS`
(`model/handles.ts`). These are distinct from the legacy `fast`/`smart`/`reasoning` tiers
(see [MODEL_CONFIG.md](MODEL_CONFIG.md)). Each tier is reached over the same
OpenAI-compatible HTTP API on its own local mlx port. The tiers map onto the processing
**depth** hierarchy: reflexive (hindbrain) → integrative (forebrain) → deliberative
(conscious).

| Tier | Depth | Default model | Port | Params | Job |
|---|---|---|---|---|---|
| **hindbrain** | reflexive | `mlx-community/Qwen3.5-2B-4bit` | `:8081` | temp 0.05, maxTokens 1024, thinking OFF | Per-event limbic appraisal (`observe`) |
| **forebrain** | integrative | `mlx-community/Qwen3.5-9B-4bit` | `:8082` | temp 0.5, maxTokens 1024, thinking OFF | Situation `orient` + the diary turn |
| **conscious** | deliberative | `mlx-community/gemma-4-31b-it-8bit` | `:8083` | temp 0.7, maxTokens 16384 | `decide`/`evaluate` + the OpenCode executor (§7) |

The tier runners are **split across the layer boundary** — this is the orient→decide seam
made physical:

- **Pre-conscious (limbic)** — `packages/core/src/brain/limbic/tiers-limbic.ts`:
  - `runHindbrain` — appraises one state-changing event into an `ObserveResult`.
  - `runForebrain` — orients on the accumulated situation into an `OrientResult`.
- **Conscious (cortex)** — `packages/core/src/brain/cortex/conscious/tiers-conscious.ts`:
  - `runConsciousDecide` — turns an orient into a `DecideResult` (plan / discover / wait /
    terminate / continue).
  - `runConsciousEvaluate` — judges a completed step and chooses a transition.
  - `runDiaryTurn` — a dedicated first-person journal turn, run on the forebrain with
    `enable_thinking:false`, so there is no `<think>` preamble to strip.

Every tier call goes through a `callTier` helper, which resolves the handle
(`resolveHandle`, `model/handles.ts`), runs the request via `ModelClient`/`ModelService`,
and archives the full prompt+response exchange. The OODA skill prompts are loaded once at
module init via `loadSkillSync`: the pre-conscious prompts (`observe.md`, `orient.md`) live
in `brain/limbic/prompts/`; the deliberative prompts (`decide.md`, `evaluate.md`,
`diary.md`) live in `brain/cortex/conscious/prompts/`.

## 3. Tick anatomy

Each iteration of the loop runs a fixed sequence of numbered steps
(`brain/loop/loop.ts`):

1. **Drain world events into state.** Each queued event is run through
   `EventProcessor.processEvent`. An event that produces a `stateUpdate` is *state-changing*;
   one that does not is *inert* and gets a deterministic fast-path (`INERT_APPRAISAL`) — no
   model call — so noise costs nothing and never escalates. Processing errors are logged
   loudly and treated as inert.
2. **Classify + critical interrupts.** `SituationClassifier.summarize` produces the
   situation; the renderer logs the state bar; `InterruptRegistry.criticals` is the amygdala
   cutting the line — if a critical fires, the in-flight conscious turn is interrupted and the
   loop returns `Interrupted`, exiting to the domain's break/social phase.
3. **Poll the in-flight conscious turn.** If a turn is running, check whether it finished; if
   so, append its output to the step report and set `stepDoneSignaled` when `detectCompletion`
   sees the done-marker.
4. **Hindbrain per-event triage.** Each state-changing event is appraised once by the 2B
   hindbrain; inert events are fast-pathed. The appraisal is **forked off the hot path** by a
   limbic-owned reflex scheduler (`brain/limbic/reflex-scheduler.ts`): the loop *submits* each
   event and *drains* the appraisals that have landed (this tick's fast reflexes plus any
   earlier slow one) — so a slow 2B call never freezes the tick. The drained `ObserveResult`s
   (plus this tick's deterministic inert ones) are reduced into one `HindbrainEscalation` via
   `appraiseTick` (see the escalation ladder in LIMBIC.md §3). Ordering contract: a reflex not
   ready by its own tick's reduce is consumed on the tick it lands (escalations queue, never
   drop); the amygdala critical check in step 2 stays synchronous, never deferred.
5. **Forebrain + deliberation.** Two disjoint call sites, never both in one tick:
   - *Idle path*: no active plan and an escalate trigger → `runForebrain` orient →
     deliberation (decide). The decision becomes a plan, a synthetic one-step discover plan
     (`isWellFormedDiscover` → `discoverToPlan`), a `wait`, or a `terminate`.
   - *In-session path*: a plan is active → apply the graded escalation ladder (`interrupt`
     kills the turn and replans; `reorient` drops the plan and lets the turn finish;
     `steer`/`accumulate` runs the forebrain and stores a coalesced steering directive — see §5).
6. **Step execution.** When a plan is active and no turn is in flight: if the agent signaled
   done or the tick budget elapsed, evaluate the step (§4); otherwise fork the next conscious
   turn — turn 1 opens the session, later turns push a coalesced steer directive into the open
   session.
7. **Sleep one tick** — `Effect.sleep(tickMs)`.

Loop constants:

| Constant | Value | Purpose |
|---|---|---|
| `DEFAULT_TICK_MS` | `30_000` | Tick interval; overridable via `tickIntervalMs` |
| `DEFAULT_ORIENT_INTERVAL` | `5` | Force an orient after this many ticks of piled-up events |
| `DEFAULT_WORKER_TIMEOUT_MS` | `60 * 60 * 1000` | Per-turn wall-clock budget (1 hour) |
| `DEFAULT_STEER_CADENCE_TICKS` | `3` | Min ticks between steer pushes (priority steers bypass it) |

### The orient→decide seam runs as a forked fiber

The decide/evaluate/diary work is not run inline on the hot path. The loop forks a
loop-owned deliberation fiber (`runDeliberation`, `brain/loop/loop.ts`) and later folds its
result back into loop state (`applyDeliberation`, `brain/loop/loop.ts`), which returns a
`CortexResult` on terminate or `null` otherwise. This keeps a slow conscious/forebrain call
from freezing the tick loop — the loop keeps draining events and honoring critical
interrupts while a deliberation is in flight. The reflexive hindbrain triage in step 4 is
**likewise forked** — off a limbic-owned reflex scheduler (`reflex-scheduler.ts`) — so a slow
2B reflex no longer freezes the conductor either; its escalation is consumed on the tick it
lands (LIMBIC.md §2). The only inline, synchronous safety-rail is the amygdala
critical-interrupt check (step 2).

## 4. Plans, steps, and completion

A `decide=plan` decision carries an array of plan steps. `planSteps` / `decideSteps`
(`brain/loop/state.ts`) always return a real array even when a small model emits a malformed
`plan` with missing or non-array `steps`, so the loop never crashes on `.length`/`.map`. An
active plan with no executable steps is a wedged-plan invariant violation
(`isWedgedEmptyPlan`, `state.ts`) that the loop fails loudly on and self-heals by re-orienting.

Each step is handed to the conscious agent via `formatStepTask` (`state.ts`), which
instructs it to print the literal completion marker `[STEP_DONE]` (`STEP_DONE_MARKER`,
`state.ts`) when the success condition is fully met. `detectCompletion` (`state.ts`) is
tolerant of surrounding text. A step also carries a `timeoutTicks` budget: if the budget
elapses with no done-signal, the loop runs a **salvage evaluate** rather than spinning forever.

Either path runs `runConsciousEvaluate`, which yields a judgment and a transition. The
transition is normalized at the parse boundary (`normalizeTransition`) into one of
`next_step` / `replan` / `wait` / `terminate`. After the evaluate, a dedicated diary turn
(`runDiaryTurn`) produces a short first-person reflection that is appended to the character's
diary; it is bounded (30s) and best-effort — a timeout or model error degrades to an empty
entry rather than stalling the loop.

## 5. Steering

When the world changes mid-plan, the loop steers the running session instead of restarting
it. The in-session escalation arms run the forebrain and format its output into a directive
with `formatSteerDirective` (`state.ts`), which only formats model-generated text — it never
splices raw inbound event text into the prompt.

Steering uses a capacity-1 coalescing slot (`pendingDirective`): newest directive wins. The
steer turn is throttled to at most one push every `DEFAULT_STEER_CADENCE_TICKS` ticks, except
a `steer`-rung escalation sets `bypassSteerCadence` so a high-salience directive is pushed
immediately (priority steer). The `reorient` and `interrupt` rungs instead drop the plan
entirely via `resetPlanState`.

## 6. Parse tolerance

The structured tiers (hindbrain/forebrain) must emit parseable JSON every tick, but the mlx
stack has **no constrained decoding** — `response_format`/json-schema is silently ignored on
the mlx provider. The engine therefore relies on a tolerant extractor rather than schema
enforcement (`packages/core/src/brain/loop/parse.ts`):

- `extractJson` resolves a fenced ```json block, else the first balanced top-level `{...}`
  object (tolerating surrounding prose via `firstBalancedObject`), else the trimmed whole
  string.
- `tryParseJson` parses without throwing.
- `parseOr` merges a successful parse over a fallback so every fallback-defined field is
  present (consumers never read `undefined`); `isPlainObject` keeps a non-object parse
  (array/string/number) off the merge path.

The forebrain runner extends this with a fallback-merge: `orientFallback` provides safe
defaults for every required field, and a parseable-but-incomplete object is merged over it
(with `sections` coerced to an array). `appraise` (`state.ts`) does the equivalent
validate-and-clamp for the hindbrain's `ObserveResult` (weight clamped 0–5, drive validated
against the closed vocabulary, disposition defaulted to `accumulate`).

Both structured tiers run with thinking **disabled** (`enable_thinking: false`). The comment
block in `model/handles.ts` records the measurement: the Qwen3.5 thinking models can exhaust
the token budget on chain-of-thought before closing the JSON (`finish=length`, content `null`
→ parse failure every tick); thinking-OFF produced valid JSON every run, ~10x faster,
equal-or-better quality. Epistemic discipline on ambiguous inputs is recovered via the orient
prompt rather than the CoT monologue. The conscious tier omits the kwarg entirely —
gemma-4-31b-it is an instruction model with no `enable_thinking` gate.

## 7. The conscious executor

The conscious tier's `decide`/`evaluate` runs against the mlx model directly, but its
*plan-step execution* runs as a tool-using OpenCode session inside the container. That session
is owned by the `ConsciousThought` service
(`packages/core/src/brain/cortex/conscious/conscious-thought.ts`).

Before the first tick the loop provisions the conscious agent exactly once
(`consciousThought.provision`). Provisioning writes the project-local character agent file,
the per-container OpenCode provider config (`provisionConsciousProvider`), and the
in-container delegation CLIs (`frontier`, `memory`, `wm`). The body model label is
`consciousModelLabel(handle)` (`model/conscious-label.ts`), which must match the agent file's
frontmatter `model:`.

Each plan step (and each steer) runs as one turn via `ConsciousThought.turn`, which calls
`runOpenCodeSessionTurn` from the shared transport layer
(`brain/transport/process-runner.ts`). Turn 1 opens a new OpenCode session; subsequent turns
resume the same session by `sessionId`. A transport failure is converted to a failed-style
result (`output` = error message) rather than crashing the loop.

### The `frontier` delegation tool

`frontier` is the conscious tier's escape hatch for heavy reasoning: a handle-based, async,
steerable worker that runs a detached frontier-model `claude` process inside the same
container (`packages/core/src/brain/cortex/conscious/frontier-cli.ts`). The generated bash CLI
exposes four verbs:

- `id=$(frontier start "<task>")` — launch a detached worker, print a handle id.
- `frontier poll "$id"` — print accumulated output and a `status:` line.
- `frontier steer "$id" "<nudge>"` — append a steer line to the worker's fifo.
- `frontier wait "$id"` — append `end`, block, print final output + `status:`.

State for each handle lives under `/tmp/frontier-<id>` on the shared container fs
(`FRONTIER_RUN_DIR = "/tmp/frontier"`), so a later conscious turn — a different `docker exec`
process — reattaches by id; the worker is detached (`setsid`) and file-backed. The worker runs
`claude` with the static flags from `buildFrontierWorkerFlags` plus a runtime `--model`: the
frontier model is the *reasoning*-tier model from `workerModels`, passed into the worker via
env (`FRONTIER_MODEL`). It never passes `--bare`.

The CLI is installed at `/usr/local/bin/frontier` (`FRONTIER_CLI_PATH`) by
`provisionFrontierCli`, invoked from `ConsciousThought.provision`. It is base64-piped in and
provisioned **as root** (`{ user: "root" }`) because `/usr/local/bin` is root-owned and the
container's default user is `node`. The `memory` long-term-store CLI
(`brain/limbic/hippocampus/memory/memory-cli.ts`) and the `wm` working-memory CLI
(`brain/limbic/wm/wm-cli.ts`) are its structural siblings — the same base64-pipe,
provision-as-root pattern. Note that the `memory` CLI is **hippocampus-owned** (long-term
episodic memory is a limbic concern), even though the conscious executor is what invokes it
in-container.
