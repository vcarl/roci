# The Brain

`packages/core/src/brain/` is the character's cognition. The directory structure **is** the
mental model: a conductor that ticks, two processing layers stacked by depth, and a shared
transport seam between them.

```
brain/
  loop/        The conductor -- runCortex tick engine, escalation reducer, parse-tolerance
  transport/   SHARED docker-exec turn plumbing (imported by both layers)
  limbic/      PRE-CONSCIOUS layer  (reflexive + integrative)
  cortex/      CONSCIOUS layer      (deliberative)
```

Two layer-neutral packages live one level up and are imported *down* into the brain:
`model/` (model→binary dispatch, tier handles) and `services/` (Docker, OAuth, CharacterFs,
CLI install, …).

## The depth hierarchy: reflexive → integrative → deliberative

Cognition deepens as you descend the tiers. Each tier is a different local model size and a
different job; the `brain/loop` conducts, and processing depth increases as work flows down.

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

## The conductor: `brain/loop`

`runCortex` (`brain/loop/loop.ts`) is the per-character tick engine. It drains domain events
off an Effect `Queue`, appraises them, orients, decides, executes, evaluates, and steers or
interrupts in-flight work as the world changes. It is **not** "the cortex" — it is the loop
that drives the cortex (and everything else). See [../../../../docs/CORTEX.md](../../../../docs/CORTEX.md)
for the full tick anatomy, the three tiers, plans/steps/completion, steering, and parse
tolerance.

- `loop.ts` — the tick engine (the conductor).
- `state.ts` — the appraisal/escalation reducer (`appraise`, `appraiseTick`,
  `HindbrainEscalation`, plan/step helpers). It is conceptually limbic (documented in
  LIMBIC.md) but physically lives here for hot-loop locality.
- `parse.ts` — tolerant JSON extraction for the mlx tiers (no constrained decoding).
- `tier-config.ts` — the `CortexRunnerConfig` the tier runners share.

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
(`cortex/conscious/tiers-conscious.ts`) plus the `ConsciousThought` executor that runs
tool-using OpenCode sessions in the container, its `frontier` heavy-reasoning delegation CLI,
the OpenCode/SDK payload plumbing, and the deliberative prompts (`decide.md`, `evaluate.md`,
`diary.md`). Full reference: [../../../../docs/CORTEX.md](../../../../docs/CORTEX.md).

### `brain/transport/` — shared turn plumbing

The layer-neutral docker-exec turn machinery: `transport.ts` (stream/race/kill core),
`payload.ts` (per-runtime inner command + normalizer), `process-runner.ts` (`runTurn` /
`runOpenCodeSessionTurn` base exec), `types.ts`, `consts.ts`. It is imported *down* by both
the limbic memory turns and the conscious executor. It never imports up into either layer.

## Load-bearing invariants

1. **Limbic and cortex NEVER import each other.** The `brain/loop` mediates the orient→decide
   handoff. That handoff runs as a **forked, loop-owned** `runDeliberation` → `applyDeliberation`
   fiber (`brain/loop/loop.ts`), so a slow conscious/forebrain call cannot freeze the tick loop.
   (The reflexive hindbrain triage still runs inline on the hot path.)

2. **The limbic→cortex boundary IS the orient→decide seam.** Observe and orient are
   pre-conscious (limbic tier runners); decide, evaluate, and execute are conscious (cortex tier
   runners). This is why the tier runners are split across the two directories rather than
   sharing one file.

3. **Memory formation/retrieval is hippocampus-owned, not cortex-owned.** The long-term vector
   store lives under `limbic/hippocampus/memory/` and is reached in-container via the `memory`
   CLI subprocess. The conscious executor *invokes* that CLI, but does not own the store.

4. **Shared/neutral infra is imported DOWN by both layers; it never imports up.** `brain/transport`,
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
(`EventProcessorTag`, `SituationClassifierTag`, `InterruptRegistryTag`, `brain/loop/loop.ts`)
and imports the tier runners and stores from their modules. Do not treat the facades as
existing; describe what the code does.
