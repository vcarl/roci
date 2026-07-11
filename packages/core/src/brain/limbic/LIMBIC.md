# Limbic System

The limbic system is the **pre-conscious** layer of the brain: a passive sensing and
signaling layer that sits between raw domain events and the conscious/deliberative
cortex. It is driven by the `brain/loop` tick engine (`runCortex`,
`packages/core/src/brain/loop/loop.ts`), which conducts everything up to and including
the **orient** step; the limbic→cortex boundary *is* the orient→decide seam. The limbic
layer handles data ingestion, situation classification, threat detection, pacing, and
memory formation/retrieval. It does not orchestrate — the loop resolves the limbic
service tags (`EventProcessorTag`, `SituationClassifierTag`, `InterruptRegistryTag` — see
`brain/loop/loop.ts:9-11`) directly and drives all decisions itself.

> **Layering invariant.** Limbic and cortex NEVER import each other. The loop mediates
> the orient→decide handoff (which runs as a forked, loop-owned
> `runDeliberation`→`applyDeliberation` fiber, `brain/loop/loop.ts:346,411`). Shared/neutral
> infra (`brain/transport`, `model/`, `services/`) is imported *down* into this layer; it
> never imports *up*. Documented lower→limbic exceptions (declarative reads, not runtime
> coupling): neutral character scaffolding (`core/character-scaffold.ts`,
> `services/CharacterFs.ts`) reads `hypothalamus/drives` templates to render `DRIVES.md` at
> scaffold time; separately, the `skills/index.ts` barrel re-exports `hypothalamus/cadence`
> (`getCadenceGuidance`).

The name comes from the biological limbic system. Each subsystem maps to a brain region
that performs an analogous function: the thalamus relays sensory input, the amygdala
detects threats, the hypothalamus regulates pacing and drives, the hippocampus forms
and consolidates episodic/narrative memory, and working memory (`wm/`) holds the
procedural plan/intent state. These are metaphors for code organization, not a
neuroscience simulation.

**Processing depth.** The limbic layer spans two tiers of the reflexive → integrative →
deliberative depth model. The *reflexive* subsystems (amygdala, hypothalamus) run on the
fast ~2B hindbrain and on pure deterministic code — no deliberation. The *integrative*
subsystems (thalamus, hippocampus, wm) run on the ~9B forebrain and on the loop's
state reducers. The *deliberative* tier (decide/evaluate/execute) belongs to the cortex,
not here.

A limbic concept documented here but physically hot-loop-resident — the **hindbrain
appraisal & escalation** (per-event drive tagging that feeds the loop's steering ladder) —
has its own section below. Its reducer lives in `brain/loop/state.ts` for hot-loop
locality, but it is conceptually the limbic appraisal layer, so it is documented here, its
mental home. The per-event appraisal itself is now **forked off the hot path** by a
limbic-owned reflex scheduler (`reflex-scheduler.ts`, §2) — the loop no longer blocks on a
slow 2B call.

## Directory Structure

```
brain/limbic/
  index.ts                          Barrel file -- the public API
  LIMBIC.md                         This document
  tiers-limbic.ts                   runHindbrain / runForebrain (the pre-conscious tier runners)
  prompts/                          Pre-conscious OODA prompt templates
    observe.md                      Hindbrain per-event appraisal prompt
    orient.md                       Forebrain situation-orientation prompt
  thalamus/                         REFLEXIVE->INTEGRATIVE -- Sensory relay
    index.ts                        Barrel
    event-processor.ts              EventProcessor service interface
    situation-classifier.ts         SituationClassifier service interface
  amygdala/                         REFLEXIVE -- Threat detection
    index.ts                        Barrel
    interrupt.ts                    InterruptRule, InterruptRegistry, createInterruptRegistry()
  hypothalamus/                     REFLEXIVE -- Pacing, cadence, innate drives
    tempo.ts                        TempoConfig discriminated union
    cadence.ts                      Cadence profile (tick pacing frame)
    drives.ts                       TEMPLATE_DRIVES, CORE_DRIVE_NAMES, renderDriveLines
  hippocampus/                      INTEGRATIVE -- Episodic / narrative memory + growth
    index.ts                        Barrel
    dream.ts                        dream.execute() -- unified consolidate + cull (one module, 3 turns)
    retrospect.ts                   Per-cycle retrospective narrative
    macro.ts                        Longer-horizon narrative rollup
    synthesis-bootstrap.ts          Seeds the synthesis / memory index
    growth-store.ts                 Growth-stage state
    identity-context.ts             Assembles the recalled-memory / identity block for prompts
    prompts/                        Dream + consolidate prompt templates (normal, good, nightmare)
    memory/                         Long-term vector store (hippocampus-owned)
      longterm-store.ts             LongtermStore Effect service seam
      memory-cli.ts                 In-container `memory` CLI generator
      memory-gateway.ts             MemoryGateway: recall/promote helpers used by the loop
      memory-embed.ts / -sql.ts / -format.ts / -args.ts   Embed, sqlite-vec, formatting, arg parsing
  wm/                               INTEGRATIVE -- Working (procedural / intent) memory
    wm-core.ts                      Plan/todo state machine + WmDelta types
    wm-store.ts                     Effect store: seed/mutate/drain WM deltas
    wm-cli.ts                       In-container `wm` CLI generator (wm.json / WM.md)
```

Agent-turn execution transport (`transport.ts`, `payload.ts`, `process-runner.ts`,
`sdk-payload.ts`, `sdk-runner/`) is **no longer a limbic subsystem** — it moved out to the
shared, layer-neutral `brain/transport/` (docker-exec turn plumbing shared by both limbic
and cortex) and, for the conscious executor pieces, into `brain/cortex/conscious/`. Runtime
binary selection (`runtime.ts`) moved to the neutral `model/`. See
[BRAIN.md](../BRAIN.md) for the transport layer.

## Thalamus -- Sensory Relay

The thalamus translates raw domain events into a format the loop can act on, and derives
structured situation summaries from accumulated state.

### EventProcessor

Translates a single domain event into an `EventResult`:

```typescript
interface EventResult {
  category?: EventCategory
  stateUpdate?: (prev: DomainState) => DomainState
  context?: DomainContext
  log?: () => void
  alert?: string              // immediate alert text for channel push
}

type EventCategory =
  | { _tag: "Heartbeat"; tick: number }
  | { _tag: "StateChange" }
  | { _tag: "LifecycleReset"; reason: string }
```

The `EventCategory` discriminated union drives the loop's dispatch. `Heartbeat` triggers
timeout checks. `StateChange` triggers full state classification and interrupt evaluation.
`LifecycleReset` clears the current plan and in-flight turn.

The `alert` field carries immediate alert text the loop can surface to the active
conscious turn.

**Tag:** `EventProcessorTag`. Domains provide a `Layer` implementing `EventProcessor`.

### SituationClassifier

Derives a structured summary from the current domain state:

```typescript
interface SituationSummary {
  situation: DomainSituation
  headline: string
  sections: Array<{ id, heading, body }>
  metrics: Record<string, string | number | boolean>
}
```

The loop feeds `SituationSummary` into interrupt evaluation, forebrain orientation, and
the console state bar.

**Tag:** `SituationClassifierTag`. Domains provide a `Layer` implementing
`SituationClassifier`.

## Amygdala -- Threat Detection

The amygdala evaluates declarative interrupt rules against the current state and
situation, producing prioritized alerts. It is the reflexive safety-rail: it can cut the
line without any deliberation.

### InterruptRule

```typescript
interface InterruptRule {
  name: string
  priority: "critical" | "high" | "medium" | "low"
  condition: (state: DomainState, situation: DomainSituation) => boolean
  message: (state: DomainState, situation: DomainSituation) => string
  suggestedAction?: string
  suppressWhenTaskIs?: string
}
```

### InterruptRegistry

Built via `createInterruptRegistry(rules)`, which handles rule walking, suppression,
priority sorting, and partitioning:

- `evaluate(state, situation, currentTask?)` -- all firing rules, sorted by priority
- `criticals(state, situation, currentTask?)` -- only critical alerts
- `softAlerts(state, situation, currentTask?)` -- non-critical alerts

Critical alerts cause `runCortex` to return `Interrupted` (exiting to the break phase),
carrying the firing `Alert[]`. Soft alerts are surfaced to the running conscious turn so
it can factor them into its work.

**Tag:** `InterruptRegistryTag`. Domains provide a `Layer` built from
`createInterruptRegistry()`.

## Hypothalamus -- Pacing, Cadence & Drives

The hypothalamus subsystem is the reflexive homeostatic layer: it does not react to any one
event, it sets the *frame* the whole loop runs inside.

- **`tempo.ts`** — the `TempoConfig` discriminated union (`TempoBase`, `StateMachineTempo`,
  `PlannedActionTempo`) describing how a phase paces itself.
- **`cadence.ts`** — the `Cadence` profile threaded into `CortexLoopConfig.cadence`; the
  tick-pacing frame the loop reads.
- **`drives.ts`** — the innate, domain-agnostic drive vocabulary (`TEMPLATE_DRIVES`,
  `CORE_DRIVE_NAMES`, `renderDriveLines`, `drivesFile`, `parseDriveNames`). See the
  *Hindbrain Appraisal & Escalation* section below for how drives feed per-event appraisal.

The `drives` templates are one documented lower→limbic exception: neutral character
scaffolding (`core/character-scaffold.ts`, `services/CharacterFs.ts`) reads them as
declarative config to render `DRIVES.md` at scaffold time. `cadence` is a separate
exception — it is re-exported by the `skills/index.ts` barrel (`getCadenceGuidance`) for
per-skill tick-pacing guidance, not read by character scaffolding.

## Hippocampus -- Episodic / Narrative Memory

The hippocampus is the **episodic / narrative** memory tier (not to be confused with
*working* memory, which now lives unambiguously in `wm/`). It keeps the character's diary
coherent and bounded so context windows don't grow unbounded, and it owns the long-term
vector store.

**Two memory lifetimes, both hippocampus-owned:**

- **Diary (narrative)** — the diary text file, rewritten and culled every cycle by
  `dream.execute()` so it never grows without bound.
- **Long-term store (episodic)** — an append-only, per-character sqlite-vec vector store at
  `brain/limbic/hippocampus/memory/`. It is reached **in-container via the `memory` CLI**
  subprocess (`memory/memory-cli.ts`), fronted on the host by the `LongtermStore` Effect
  service (`memory/longterm-store.ts`) and the `MemoryGateway` recall helpers
  (`memory/memory-gateway.ts`) that the loop calls. Rows are embedded and never updated or
  deleted; the point is durable ground truth that survives the diary cull. See
  [docs/MEMORY.md](../../../../../docs/MEMORY.md) for the full long-term architecture.

### dream.execute()

`dream` (`dream.ts`) is the per-cycle, all-domains memory compression: a **single unified**
consolidate-and-cull step run in the reflection phase
(`core/orchestrator/planned-action.ts`, `runReflection`). It is one orchestrated operation
with three sequential local-model turns — **every turn resolves the single
`dreamCompression` role, which defaults to the local conscious-tier mlx model (opencode
runtime); Claude is never invoked in the reflection path.**

1. **Consolidate** — read the current `DIARY.md` (prior diary plus this session's raw
   per-step appends) and rewrite it into coherent narrative entries
   (`hippocampus/prompts/consolidate.md` prompt, `noTools`). May *grow* the file; the cull
   below reins it back in. A failed/blank turn keeps the original diary untouched and is
   surfaced as a structured `kind:"error"` event.
2. **Cull diary** — compress the (consolidated) diary down toward
   `DIARY_TARGET_LINES = 150` (`dream.ts:29`), clamped to **never grow** the file.
3. **Cull secrets** — same never-grows compression applied to `SECRETS.md`.

The dream type (used for the cull prompts) is probabilistic:

- **Normal** (most common) -- straightforward compression
- **Good** (roll >= 94) -- optimistic tone
- **Nightmare** (roll < secretsLines/6, max 15%) -- darker, more paranoid compression

The probability of nightmares scales with the number of secrets a character has
accumulated. Each dream type uses different prompt templates from `hippocampus/prompts/`.
Every cull turn is guarded by the same blank-turn / never-grows checks, so a timeout or
bloated output keeps the original content rather than wiping or growing the file.

**Dependencies:** `CharacterFs`, `CharacterLog` (plus the shared process runner / OAuth for
the turns).

## Working Memory (`wm/`) -- Procedural / Intent State

Working memory is the plan/todo state machine (`wm.json` / `WM.md`): the character's
*current intent*, distinct from the hippocampus's narrative recall. `wm-core.ts` is the
pure state machine + `WmDelta` types; `wm-store.ts` is the Effect store the loop drives
(`seedWmPlan`, `mutateWm`, `drainWmDeltas`, `closePlanTodos`, `discardDeadPlanTodos`);
`wm-cli.ts` generates the in-container `wm` CLI the conscious agent uses to read/update its
own plan.

## Hindbrain Appraisal & Escalation -- the limbic drives

This is the limbic system's appraisal layer: the fast, pre-conscious read of *"does this
event matter, and how much?"* It is conceptually a limbic/hindbrain region (the amygdala's
calmer sibling -- graded salience rather than binary threat), so it is documented here, its
mental home. Note, however, that the **reducer physically lives in `brain/loop/state.ts`**,
not under `brain/limbic/`: the appraisal runs on the hot path every tick, so it is
co-located with the loop state it mutates for locality. Only the drive *vocabulary*
(`brain/limbic/hypothalamus/drives.ts`) sits in the hypothalamus subsystem. This section
documents both, citing across that boundary.

### 1. Drives -- what the character cares about

Drives are the reference frame the hindbrain weighs each event against. Three **innate,
domain-agnostic** drives are defined verbatim in `brain/limbic/hypothalamus/drives.ts`
(`TEMPLATE_DRIVES`, severity order safety > sustenance > agency,
`CORE_DRIVE_NAMES = ["safety","sustenance","agency"]`):

- **safety** -- physical integrity, or someone targeting you personally (attack, damage, threat).
- **sustenance** -- the resources you need to keep operating (fuel, energy, money/credits, quota,
  rate budget). The drive block carries explicit anti-collapse routing (money/fuel/quota =
  sustenance, **not** safety) that lifted the 2B's drive-tagging to a stable ~85%.
- **agency** -- your freedom and ability to act (blocked, locked out, frozen, disabled, shutdown).

Domains contribute their own **domain drives** via
`DomainConfig.identityTemplate.domainDrives`; `renderDriveLines(domainDrives?)`
(`drives.ts`) appends one `- name — description` row per domain drive to the core block,
and `parseDriveNames` recovers the closed vocabulary for validation. The rendered block is
written into the character's `DRIVES.md` (`drivesFile`) at scaffold time -- the companion to
`PALETTE.md` (drives = what it cares about; palette = how it feels). The same block is the
per-event observe prompt's tagging vocabulary.

### 2. Per-event appraisal -- the hindbrain observe

The hindbrain (the small/fast "2B" tier) is invoked **once per state-changing event** and
returns a single `ObserveResult` (`skills/types.ts`) tagging that event:

```typescript
interface ObserveResult {
  disposition: "discard" | "accumulate" | "escalate"
  emotionalWeight: string   // emoji mood painted from the character's palette
  drive: string | null      // which drive this bears on (validated against the closed vocab)
  weight: number            // 0–5 salience/threat for THIS event
  interrupt?: boolean        // drop-everything signal (default false)
  reason: string
}
```

The model's raw structured output is laundered through `appraise(raw, knownDrives?)`
(`brain/loop/state.ts`) before it can drive control flow: `weight` is clamped to an integer
0–5, `drive` is validated against the closed vocabulary (unknown → `null`), `disposition`
defaults to the safe `accumulate`, and `interrupt` is coerced to a strict boolean. It is
pure and never throws.

**Inert events never reach the model.** An event that produced no `stateUpdate` is tagged
deterministically by the `INERT_APPRAISAL` fast-path (`brain/loop/loop.ts:116`) --
`discard`/weight-0, no model call (habituation to non-salient stimuli, so noise costs
nothing). Only state-changing events are sent to the 2B observe.

**The appraisal is forked off the hot path** (`reflex-scheduler.ts`). Each state-changing
event's 2B observe -- plus its per-event `observeMemories → remember` write -- runs on a
forked fiber, not inline on the tick. A slow 2B call (observed up to ~17.5 min) therefore
never freezes the conductor: event draining and the synchronous amygdala critical-interrupt
check keep running while the reflex is in flight. The scheduler's surface is minimal:

- `submit(event, waitState)` -- fork one event's appraisal; returns immediately.
- `drainReady()` -- non-blocking poll of the appraisals that have **landed**, in submission
  order (FIFO). The loop merges these with this tick's deterministic inert appraisals and
  feeds the combined set to `appraiseTick`.
- `interruptAll()` -- interrupt every in-flight reflex; called on the amygdala critical exit
  (a dropped session's reflexes are moot), mirroring the loop's `consciousFiber`/
  `deliberationFiber` interrupts.

**Ordering contract (load-bearing).** A reflex submitted on tick *T* that has not landed by
*T*'s reduce is consumed on the tick it lands (*T+k*): escalations **queue and are consumed
exactly once, never dropped and never reordered relative to each other**. The event's raw
text likewise reaches `accumulatedEvents` (and the forebrain) one tick later than the old
inline path -- a benign, documented lag. The **amygdala hard-interrupt** path (`interrupts.
criticals`, evaluated synchronously in the loop) is NOT routed through the scheduler, so a
critical "cut-the-line" is never deferred behind a pending reflex. A reflex whose 2B model
call *fails* degrades to a non-escalating `accumulate` appraisal (mirroring `runHindbrain`'s
own parse-miss default) rather than crashing the conductor -- off-hot-path robustness over
deferred crash-loud.

### 3. The escalation ladder

Each appraised event earns a rung on an ordered ladder (`EscalationRung`, `state.ts`):

| Rung | Earned when (`eventRung`) |
|------|--------------------------------------------|
| `none` | `disposition: "discard"` and below the steer threshold |
| `accumulate` | non-discard, but low salience |
| `steer` | `weight >= steer threshold` **or** `disposition: "escalate"` |
| `reorient` | `weight >= reorient threshold` |
| `interrupt` | explicit `interrupt: true` only -- **never weight alone** |

Thresholds are tunable (`DEFAULT_APPRAISAL_THRESHOLDS = { steer: 4, reorient: 5 }`,
`state.ts`). The 2B hindbrain is **capped at `reorient`**: the hard-`interrupt` rung is
gated behind an explicit `interrupt: true`, reserved for the amygdala / a future stronger
tier / a genuine redundant physical-attack appraisal.

`appraiseTick(results, thresholds)` (`state.ts`) reduces the tick's per-event appraisals
into one `HindbrainEscalation` (`state.ts`): the tick `rung` is the **MAX** rung across
events; `maxWeight` and `dominant` come from the highest-weight event (ties → first);
`accumulated` is the raw text of every non-discard event; `escalate` is true at `steer` or
above. The loop calls `appraiseTick` each tick and consumes the returned
`HindbrainEscalation` directly -- the seam between the limbic appraisal and the loop is
**guaranteed well-formed** every tick (never undefined; `emptyEscalation()` when there were
no events or nothing salient).

### 4. How the loop consumes it

Each tick, after triaging events into one `HindbrainEscalation`, the loop takes one of two
disjoint paths:

- **Idle (no active plan)** -- if anything escalated (or it's the first tick, or accumulated
  events have aged past `orientInterval` via `shouldForceOrient`), run the forebrain
  orient → (forked deliberation) → conscious decide → plan/wait/discover/terminate. The
  dominant event's mood becomes the tick mood; accumulated event text feeds the orient.
- **In-session (plan active)** -- apply the graded ladder against the in-flight conscious
  turn:
  - `interrupt` → kill the in-flight turn, drop the plan, reorient now.
  - `reorient` → drop the plan so the next tick re-orients; the current turn finishes
    naturally (not interrupted).
  - `steer` / `accumulate` → run the forebrain and store its output as a coalescing
    `pendingDirective` (`formatSteerDirective`); a `steer`-rung event bypasses the
    steer-cadence throttle, an `accumulate`-rung event steers on the normal throttle.

This in-LOOP graded route is distinct from the **amygdala critical path**: a critical
interrupt (section *Amygdala*) makes `runCortex` **return `Interrupted` and exit** to the
break phase, whereas the hindbrain `interrupt` rung stays inside the loop (kill turn,
reorient, keep running). The two are deliberately separate escalation routes.

## Barrel File Contract

The core limbic services are re-exported through `brain/limbic/index.ts`:

```typescript
import { EventProcessorTag, InterruptRegistryTag, dream } from '../limbic'
import type { EventResult, SituationSummary, TempoConfig } from '../limbic'
```

Exported surface by subsystem (verified against `brain/limbic/index.ts`):

| Subsystem | Types | Values |
|-----------|-------|--------|
| Thalamus | `EventProcessor`, `EventResult`, `EventCategory`, `DomainContext`, `SituationClassifier`, `SituationSummary` | `EventProcessorTag`, `SituationClassifierTag` |
| Amygdala | `InterruptRule`, `InterruptRegistry`, `Alert` * | `InterruptRegistryTag`, `createInterruptRegistry` |
| Hypothalamus | `TempoConfig`, `TempoBase`, `StateMachineTempo`, `PlannedActionTempo` | *(none)* |
| Hippocampus | `DreamType`, `DreamInput`, `DreamOutput` | `dream`, `DIARY_TARGET_LINES`, `REFLECTION_TURN_TIMEOUT_MS`, `CULL_TURN_TIMEOUT_MS`, `REFLECTION_CONTEXT_MAX` |

\* `Alert` is re-exported by the barrel but is sourced from `core/types.ts` (`../../core/types.js`),
not the amygdala module.

The hypothalamus subsystem exports **only** the Tempo types through this barrel. The drive
vocabulary (`TEMPLATE_DRIVES` / `renderDriveLines` / …) and the tier runners
(`runHindbrain` / `runForebrain`) are re-exported through the **package root** barrel
(`packages/core/src/index.ts`), not the limbic barrel. Working-memory helpers
(`wm/wm-store.js`), the `MemoryGateway`, and the `LongtermStore` are imported by the loop
from their modules directly.
