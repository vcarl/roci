# The Brain

`packages/core/src/brain/` is the character's cognition. The directory structure **is** the
mental model: a conductor that ticks, two processing layers stacked by depth, and a shared
transport seam between them.

```
brain/
  stem/        The conductor -- runActivation tick engine, escalation reducer, parse-tolerance
    transport/ SHARED docker-exec turn plumbing (imported by both layers)
  limbic/      PRE-CONSCIOUS layer  (reflexive + integrative)
  cortex/      CONSCIOUS layer      (deliberative)
```

Two layer-neutral packages live one level up and are imported *down* into the brain:
`model/` (model→binary dispatch, tier handles) and `services/` (Docker, OAuth, CharacterFs,
CLI install, …).

## The depth hierarchy: reflexive → integrative → deliberative

Cognition deepens as you descend the tiers. Each tier is a different local model size and a
different job; the `brain/stem` conducts, and processing depth increases as work flows down.

| Depth | Tier | ~Size | Where | Job |
|---|---|---|---|---|
| **Reflexive** | hindbrain | ~2B | `limbic/amygdala`, `limbic/hypothalamus` | Threat/interrupt safety-rail; per-event appraisal; pacing & innate drives |
| **Integrative** | forebrain | ~9B | `limbic/thalamus`, `limbic/hippocampus`, `limbic/wm` | Event relay & classification; situation orient; episodic/narrative + working memory |
| **Deliberative** | conscious | ~31B | `cortex/conscious` | Decide / evaluate / execute tool-using work |

- **Reflexive** work is fast and mostly stimulus-bound: the amygdala can cut the line
  (critical interrupt) and the hypothalamus sets the pacing frame — neither deliberates.
- **Integrative** work assembles a coherent picture: the thalamus relays and classifies
  events, the hippocampus forms/retrieves memory, working memory holds the current intent, and
  the forebrain *orients* on the accumulated situation.
- **Deliberative** work is the cortex: it *decides* what to do, *executes* it as a tool-using
  OpenCode session, and *evaluates* the outcome.

## The conductor: `brain/stem`

`runActivation` (`brain/stem/loop.ts`) is the per-character tick engine. It is a thin
conductor — named for the activation/reticular-activating role it plays, not "the cortex":
it paces ticks, drains domain events off an Effect `Queue`, dispatches them to the limbic
and cortex layers, and steers or interrupts in-flight work as the world changes. It does
**not** run the cortex itself — conscious-session lifecycle lives in `cortex/conscious/`
and reflex scheduling lives in `limbic/`; the loop only owns pacing/polling/dispatch and
the loop-owned orient→decide fork (the one seam licensed to touch both layers). See
[../../../../docs/CORTEX.md](../../../../docs/CORTEX.md) for the full tick anatomy, the
three tiers, plans/steps/completion, steering, and parse tolerance.

- `loop.ts` — the tick engine (the conductor).
- `state.ts` — the appraisal/escalation reducer (`appraise`, `appraiseTick`,
  `HindbrainEscalation`, plan/step helpers). It is conceptually limbic (documented in
  LIMBIC.md) but physically lives here for hot-loop locality.
- `parse.ts` — tolerant JSON extraction for the mlx tiers (no constrained decoding).
- `tier-config.ts` — the `ActivationRunnerConfig` the tier runners share.

## The two layers

### `brain/limbic/` — the pre-conscious layer

Everything up to and including **orient**. Sensing, classification, threat detection, pacing,
and memory. Its tier runners are the reflexive `runHindbrain` and the integrative
`runForebrain` (`limbic/tiers-limbic.ts`). Subsystems: `amygdala/` (interrupt safety-rail),
`hypothalamus/` (tempo · cadence · drives), `thalamus/` (event relay · situation classifier),
`hippocampus/` (dream consolidate+cull, retrospect, growth, and the long-term vector store at
`hippocampus/memory/`), and `wm/` (working / procedural-intent memory). Full reference:
[limbic/LIMBIC.md](limbic/LIMBIC.md).

### `brain/cortex/conscious/` — the conscious layer

The deliberative tier: `runConsciousDecide` / `runConsciousEvaluate` / `runDiaryTurn`
(`cortex/conscious/tiers-conscious.ts`), the `ConsciousThought` executor that runs tool-using
OpenCode sessions in the container, and the `ConsciousSession` owner
(`cortex/conscious/conscious-session.ts`) that holds the conscious-session lifecycle behind a
narrow interface (the in-flight turn fiber, sessionId, step report, done-signal, and steer
coalesce/cadence state; the loop drives it via `poll`/`openTurn`/`steer`/`evaluate`/`diary`/
`interrupt`/`reset`). Plus the `frontier` heavy-reasoning delegation CLI, the OpenCode/SDK
payload plumbing, and the deliberative prompts (`decide.md`, `evaluate.md`, `diary.md`). The
session owner imports **no limbic code** — all wm/memory/episode bookkeeping stays loop-side.
Full reference: [../../../../docs/CORTEX.md](../../../../docs/CORTEX.md).

### `brain/stem/transport/` — shared turn plumbing

The layer-neutral docker-exec turn machinery: `transport.ts` (stream/race/kill core),
`payload.ts` (per-runtime inner command + normalizer), `process-runner.ts` (`runTurn` /
`runOpenCodeSessionTurn` base exec), `types.ts`, `consts.ts`. It is imported *down* by both
the limbic memory turns and the conscious executor. It never imports up into either layer.

## Load-bearing invariants

1. **Limbic and cortex NEVER import each other.** The `brain/stem` mediates the orient→decide
   handoff. That handoff runs as a **forked, loop-owned** `runDeliberation` → `applyDeliberation`
   fiber (`brain/stem/loop.ts`), so a slow conscious/forebrain call cannot freeze the tick loop.
   The reflexive hindbrain triage is likewise **forked off the hot path** by a limbic-owned
   reflex scheduler (`brain/limbic/reflex-scheduler.ts`): the loop *submits* each state-changing
   event's appraisal and *drains* the ones that have landed into the tick's escalation reduce, so
   a slow 2B reflex cannot freeze the conductor either. Ordering contract: a reflex not ready by
   its own tick's reduce is consumed on the tick it lands (escalations queue, never drop); the
   amygdala critical-interrupt path stays synchronous, so a "cut-the-line" is never deferred.
   The conscious-session *lifecycle* (turn fiber, sessionId, step report, steer state) lives in
   cortex (`cortex/conscious/conscious-session.ts`) behind a narrow interface, but its
   wm/memory/episode *bookkeeping* stays loop-side — the owner imports no limbic code, so the
   loop remains the only module that touches both layers. That bookkeeping is delegated to
   named helpers co-located with their owners: the plan-todo seed/settle/discard composites to a
   limbic-owned tracker (`limbic/wm/plan-todos.ts`, which composes only `wm-store` and returns
   the applied deltas) and the step-start/step-end/wm record writers to `logging/episodes.ts`.
   The loop drives both and is the single site that pairs the wm deltas with their episode
   records — the tracker never imports `logging`/cortex, keeping the layer wall intact.

2. **The limbic→cortex boundary IS the orient→decide seam.** Observe and orient are
   pre-conscious (limbic tier runners); decide, evaluate, and execute are conscious (cortex tier
   runners). This is why the tier runners are split across the two directories rather than
   sharing one file.

3. **Memory formation/retrieval is hippocampus-owned, not cortex-owned.** The long-term vector
   store lives under `limbic/hippocampus/memory/` and is reached in-container via the `memory`
   CLI subprocess. The conscious executor *invokes* that CLI, but does not own the store.

4. **Shared/neutral infra is imported DOWN by both layers; it never imports up.** `brain/stem/transport`,
   `model/`, and `services/` know nothing about limbic or cortex. Documented lower→limbic
   exceptions (declarative reads, not runtime coupling): neutral character scaffolding
   (`core/character-scaffold.ts`, `services/CharacterFs.ts`) reads `limbic/hypothalamus/drives`
   templates as declarative config to render `DRIVES.md` at scaffold time; separately, the
   `skills/index.ts` barrel re-exports `limbic/hypothalamus/cadence` (`getCadenceGuidance`), which
   is unrelated to scaffolding or `DRIVES.md`.

## Not-yet-built: the layer facades

The refactor spec described `Limbic` and `Cortex` Effect **service facades** that would front
each layer behind a single tag. That facade rewire is a **planned follow-up — it is not
implemented today.** The loop currently resolves the individual service tags directly
(`EventProcessorTag`, `SituationClassifierTag`, `InterruptRegistryTag`, `brain/stem/loop.ts`)
and imports the tier runners and stores from their modules. Do not treat the facades as
existing; describe what the code does.
