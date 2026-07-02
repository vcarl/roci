# The Cortex Loop

The cortex loop is the harness's execution engine: a per-character cognitive tick
loop that drains domain events, appraises them across three model tiers, plans and
executes work, and steers or interrupts in-flight work as the world changes. It
replaces the older persistent `claude --channels` "channel session" pipeline
(`runChannelSession`), which has been deleted.

This document is the architecture reference for the engine. For the surrounding
mental model see [../HARNESS.md](../HARNESS.md); for the domain-agnostic limbic
services the loop consumes see
[LIMBIC.md](../packages/core/src/core/limbic/LIMBIC.md); for the OODA skill
templates the tiers render see [OPERATING_SKILLS.md](OPERATING_SKILLS.md).

## 1. What the loop is

`runCortex(config)` is exported from
`packages/core/src/cortex/loop.ts:104` and re-exported from the package barrel at
`packages/core/src/index.ts:82`. It runs once per character: each domain calls it
from the `active` phase —
`packages/domain-spacemolt/src/phases.ts:170` and
`packages/domain-github/src/phases.ts:241`, both importing it from
`@roci/core/cortex/loop.js`.

The loop is an infinite `while (true)` tick loop (`loop.ts:201`). World events do
not stream into a running CLI session; they arrive on an Effect `Queue`
(`CortexLoopConfig.events: Queue.Queue<unknown>`, `loop.ts:58`) that each tick
drains non-blocking. The loop owns cognition (appraise → orient → decide → execute
→ evaluate); the actual tool-using work happens in a separate OpenCode session it
forks and resumes (see §7).

`CortexLoopConfig` (`loop.ts:53-66`) carries: `char`, `containerId`,
`containerEnv`, `addDirs`, `events`, `initialState`, `cadence`, `cortexModels`,
`workerModels`, `orientInterval`, `workerTimeoutMs`, `tickIntervalMs`. The loop
returns a `CortexResult` (`loop.ts:68-70`): `Completed` (with `finalState`) or
`Interrupted` (with `finalState` + `criticals`).

## 2. The three tiers

Cognition is split across three model tiers — `hindbrain`, `forebrain`,
`conscious` — defined as `CortexTier` (`model/handles.ts:2`) and configured by
`DEFAULT_CORTEX_MODELS` (`model/handles.ts:54-130`). These are distinct from the
legacy `fast`/`smart`/`reasoning` tiers (see
[MODEL_CONFIG.md](MODEL_CONFIG.md)). Each tier is reached over the same
OpenAI-compatible HTTP API on its own local mlx port:

| Tier | Default model | Port | Params | Job |
|---|---|---|---|---|
| **hindbrain** | `mlx-community/Qwen3.5-2B-4bit` | `:8081` | temp 0.05, maxTokens 1024, thinking OFF | Per-event limbic appraisal (`observe`) |
| **forebrain** | `mlx-community/Qwen3.5-9B-4bit` | `:8082` | temp 0.5, maxTokens 1024, thinking OFF | Situation `orient` + the diary turn |
| **conscious** | `mlx-community/gemma-4-31b-it-8bit` | `:8083` | temp 0.7, maxTokens 16384 | `decide`/`evaluate` + the OpenCode executor (§7) |

Anchors: hindbrain `handles.ts:90-100`, forebrain `handles.ts:108-118`, conscious
`handles.ts:123-129`. The tier runners live in
`packages/core/src/cortex/tiers.ts`:

- `runHindbrain` (`tiers.ts:118`) — appraises one state-changing event into an
  `ObserveResult`.
- `runForebrain` (`tiers.ts:165`) — orients on the accumulated situation into an
  `OrientResult`.
- `runConsciousDecide` (`tiers.ts:219`) — turns an orient into a `DecideResult`
  (plan / discover / wait / terminate / continue).
- `runConsciousEvaluate` (`tiers.ts:277`) — judges a completed step and chooses a
  transition.
- `runDiaryTurn` (`tiers.ts:314`) — a dedicated first-person journal turn, run on
  the forebrain with `enable_thinking:false`, so there is no `<think>` preamble to strip.

Every tier call goes through `callTier` (`tiers.ts:84`), which resolves the handle
(`resolveHandle`, `handles.ts:163`), runs the request via `ModelService.withTier`,
and archives the full prompt+response exchange with `logExchange`. The OODA skill
prompts are loaded once at module init via `loadSkillSync` from `src/skills/`
(`tiers.ts:27-34`): `observe.md`, `orient.md`, `decide.md`, `evaluate.md`,
`diary.md`.

## 3. Tick anatomy

Each iteration of the loop runs seven numbered steps (`loop.ts:201-613`):

1. **Drain world events into state** (`loop.ts:204-240`). Each queued event is run
   through `EventProcessor.processEvent`. An event that produces a `stateUpdate` is
   *state-changing*; one that does not is *inert* and gets a deterministic
   fast-path (`INERT_APPRAISAL`, `loop.ts:92-99`) — no model call — so noise costs
   nothing and never escalates. Processing errors are logged loudly and treated as
   inert.
2. **Classify + critical interrupts** (`loop.ts:242-255`). `SituationClassifier.summarize`
   produces the situation; `renderer.formatStateBar(summary.metrics)` logs the
   state bar; `InterruptRegistry.criticals` is the amygdala cutting the line — if a
   critical fires, the in-flight conscious turn is interrupted and the loop returns
   `Interrupted`, exiting to the domain's break/social phase.
3. **Poll the in-flight conscious turn** (`loop.ts:257-273`). If a turn is running,
   check whether it finished; if so, append its output to the step report and set
   `stepDoneSignaled` when `detectCompletion` sees the done-marker.
4. **Hindbrain per-event triage** (`loop.ts:275-310`). Each state-changing event is
   appraised once by the 2B hindbrain; inert events are fast-pathed. The per-event
   `ObserveResult`s are reduced into one `HindbrainEscalation` via `appraiseTick`
   (see §4 of LIMBIC.md / the escalation ladder), surfaced on `cortex.escalation`.
5. **Forebrain** (`loop.ts:312-427`) — two disjoint call sites, never both in one
   tick:
   - *Idle path* (`loop.ts:313-369`): no active plan and an escalate trigger →
     `runForebrain` orient → `runConsciousDecide`. The decision becomes a plan
     (`decideSteps` > 0), a synthetic one-step discover plan
     (`isWellFormedDiscover` → `discoverToPlan`), a `wait`, or a `terminate`.
   - *In-session path* (`loop.ts:370-427`): a plan is active → apply the graded
     escalation ladder (`interrupt` kills the turn and replans; `reorient` drops
     the plan and lets the turn finish; `steer`/`accumulate` runs forebrain and
     stores a coalesced steering directive — see §5).
6. **Step execution** (`loop.ts:429-610`). When a plan is active and no turn is in
   flight: if the agent signaled done or the tick budget elapsed, evaluate the step
   (§4); otherwise fork the next conscious turn — turn 1 opens the session, later
   turns push a coalesced steer directive into the open session.
7. **Sleep one tick** (`loop.ts:612-613`) — `Effect.sleep(tickMs)`.

Loop constants (`loop.ts:72-84`):

| Constant | Value | Purpose |
|---|---|---|
| `DEFAULT_TICK_MS` | `30_000` | Tick interval; overridable via `tickIntervalMs` |
| `DEFAULT_ORIENT_INTERVAL` | `5` | Force an orient after this many ticks of piled-up events |
| `DEFAULT_WORKER_TIMEOUT_MS` | `60 * 60 * 1000` | Per-turn wall-clock budget (1 hour) |
| `DEFAULT_STEER_CADENCE_TICKS` | `3` | Min ticks between steer pushes (priority steers bypass it) |

## 4. Plans, steps, and completion

A `decide=plan` decision carries an array of plan steps. `planSteps` /
`decideSteps` (`state.ts:199` / `state.ts:210`) always return a real array even
when a small model emits a malformed `plan` with missing or non-array `steps`, so
the loop never crashes on `.length`/`.map`. An active plan with no executable steps
is a wedged-plan invariant violation (`isWedgedEmptyPlan`, `state.ts:273`) that the
loop fails loudly on and self-heals by re-orienting (`loop.ts:433-445`).

Each step is handed to the conscious agent via `formatStepTask` (`state.ts:310`),
which instructs it to print the literal completion marker `[STEP_DONE]`
(`STEP_DONE_MARKER`, `state.ts:282`) when the success condition is fully met.
`detectCompletion` (`state.ts:289`) is tolerant of surrounding text. A step also
carries a `timeoutTicks` budget: if the budget elapses with no done-signal, the
loop runs a **salvage evaluate** (`loop.ts:452-465`) rather than spinning forever.

Either path runs `runConsciousEvaluate`, which yields a judgment and a transition.
The transition is normalized at the parse boundary (`normalizeTransition`,
`tiers.ts:266`) into one of `next_step` / `replan` / `wait` / `terminate`
(`loop.ts:534-552`). After the evaluate, a dedicated diary turn (`runDiaryTurn`,
invoked at `loop.ts:497`) produces a short first-person reflection that is appended
to the character's diary; it is bounded (30s) and best-effort — a timeout or model
error degrades to an empty entry rather than stalling the loop.

## 5. Steering

When the world changes mid-plan, the loop steers the running session instead of
restarting it. The in-session escalation arms run the forebrain and format its
output into a directive with `formatSteerDirective` (`state.ts:298`), which only
formats model-generated text — it never splices raw inbound event text into the
prompt.

Steering uses a capacity-1 coalescing slot (`pendingDirective`, `loop.ts:163-168`):
newest directive wins. The steer turn is throttled to at most one push every
`DEFAULT_STEER_CADENCE_TICKS` ticks (`loop.ts:84`, consumed at `loop.ts:582-606`),
except a `steer`-rung escalation sets `bypassSteerCadence` so a high-salience
directive is pushed immediately (priority steer, `loop.ts:401-423`). The
`reorient` and `interrupt` rungs instead drop the plan entirely via
`resetPlanState` (`loop.ts:175-184`).

## 6. Parse tolerance

The structured tiers (hindbrain/forebrain) must emit parseable JSON every tick, but
the mlx stack has **no constrained decoding** — `response_format`/json-schema is
silently ignored on the mlx provider (`handles.ts:18-24`). The engine therefore
relies on a tolerant extractor rather than schema enforcement
(`packages/core/src/cortex/parse.ts`):

- `extractJson` (`parse.ts:50`) resolves a fenced ```json block, else the first
  balanced top-level `{...}` object (tolerating surrounding prose via
  `firstBalancedObject`, `parse.ts:9`), else the trimmed whole string.
- `tryParseJson` (`parse.ts:77`) parses without throwing.
- `parseOr` (`parse.ts:100`) merges a successful parse over a fallback so every
  fallback-defined field is present (consumers never read `undefined`);
  `isPlainObject` (`parse.ts:65`) keeps a non-object parse (array/string/number)
  off the merge path.

The forebrain runner extends this with a fallback-merge (`tiers.ts:155-216`):
`orientFallback` provides safe defaults for every required field, and a
parseable-but-incomplete object is merged over it (with `sections` coerced to an
array). `appraise` (`state.ts:108`) does the equivalent validate-and-clamp for the
hindbrain's `ObserveResult` (weight clamped 0–5, drive validated against the closed
vocabulary, disposition defaulted to `accumulate`).

Both structured tiers run with thinking **disabled**
(`enable_thinking: false`, `handles.ts:98,116`). The comment block at
`handles.ts:54-89` records the measurement: the Qwen3.5 thinking models can exhaust
the token budget on chain-of-thought before closing the JSON (`finish=length`,
content `null` → parse failure every tick); thinking-OFF produced valid JSON every
run, ~10x faster, equal-or-better quality. Epistemic discipline on ambiguous inputs
is recovered via the orient prompt rather than the CoT monologue. The conscious
tier omits the kwarg entirely — gemma-4-31b-it is an instruction model with no
`enable_thinking` gate (`handles.ts:78-80,119-122`).

## 7. The conscious executor

The conscious tier's `decide`/`evaluate` runs against the mlx model directly, but
its *plan-step execution* runs as a tool-using OpenCode session inside the
container. That session is owned by the `ConsciousThought` service
(`packages/core/src/conscious/conscious-thought.ts:57`).

Before the first tick the loop provisions the conscious agent exactly once
(`loop.ts:186-199` → `consciousThought.provision`). Provisioning
(`conscious-thought.ts:89-130`) writes the project-local character agent file, the
per-container OpenCode provider config (`provisionConsciousProvider`), and the two
in-container delegation CLIs (§frontier below, and the `memory` CLI). The body
model label is `consciousModelLabel(handle)` (`loop.ts:190`), which must match the
agent file's frontmatter `model:`.

Each plan step (and each steer) runs as one turn via `ConsciousThought.turn`
(`conscious-thought.ts:78`), which calls `runOpenCodeSessionTurn`
(`process-runner.ts:180`, imported at `conscious-thought.ts:7`). Turn 1 opens a new
OpenCode session; subsequent turns resume the same session by `sessionId`
(`loop.ts:563-606`). A transport failure is converted to a failed-style result
(`output` = error message) rather than crashing the loop
(`conscious-thought.ts:152-159`).

### The `frontier` delegation tool

`frontier` is the conscious tier's escape hatch for heavy reasoning: a handle-based,
async, steerable worker that runs a detached frontier-model `claude` process inside
the same container (`packages/core/src/conscious/frontier-cli.ts`). The generated
bash CLI exposes four verbs (`frontier-cli.ts:39-47`, implemented in the script at
`frontier-cli.ts:91-183`):

- `id=$(frontier start "<task>")` — launch a detached worker, print a handle id.
- `frontier poll "$id"` — print accumulated output and a `status:` line.
- `frontier steer "$id" "<nudge>"` — append a steer line to the worker's fifo.
- `frontier wait "$id"` — append `end`, block, print final output + `status:`.

State for each handle lives under `/tmp/frontier-<id>` on the shared container fs
(`FRONTIER_RUN_DIR = "/tmp/frontier"`, `frontier-cli.ts:9`), so a later conscious
turn — a different `docker exec` process — reattaches by id; the worker is detached
(`setsid`) and file-backed. The worker runs `claude` with the static flags from
`buildFrontierWorkerFlags` (`frontier-cli.ts:18`) plus a runtime `--model`: the
frontier model is the *reasoning*-tier model from `workerModels`
(`loop.ts:197`, `frontierModel: (config.workerModels ?? DEFAULT_MODEL_CONFIG).tiers.reasoning`),
passed into the worker via env (`FRONTIER_MODEL`). It never passes `--bare`.

The CLI is installed at `/usr/local/bin/frontier` (`FRONTIER_CLI_PATH`,
`frontier-cli.ts:7`) by `provisionFrontierCli` (`frontier-cli.ts:199-210`), invoked
from `ConsciousThought.provision` (`conscious-thought.ts:106-109`). It is base64-piped
in and provisioned **as root** (`{ user: "root" }`, `frontier-cli.ts:208`; commit
`35cce83`) because `/usr/local/bin` is root-owned and the container's default user
is `node`. The `memory` long-term-store CLI (`conscious/memory-cli.ts`, provisioned
at `conscious-thought.ts:115`) is its structural sibling — the same base64-pipe,
provision-as-root pattern.
