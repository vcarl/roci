# Limbic System

The limbic system is a passive sensing and signaling layer that sits between raw domain events and the orchestration engines (`runStateMachine`, `runPlannedAction`). It handles data ingestion, situation classification, threat detection, homeostatic regulation, and memory consolidation. It does not orchestrate -- the orchestrator layer consumes limbic services to make decisions.

The name comes from the biological limbic system. Each subsystem maps to a brain region that performs an analogous function: the thalamus relays sensory input, the amygdala detects threats, the hypothalamus maintains homeostasis, and the hippocampus consolidates memory. These are metaphors for code organization, not a neuroscience simulation.

## Directory Structure

```
core/limbic/
  index.ts                          Barrel file -- the public API
  LIMBIC.md                         This document
  thalamus/                         Sensory relay
    index.ts                        Barrel
    event-processor.ts              EventProcessor service interface
    situation-classifier.ts         SituationClassifier service interface
  amygdala/                         Threat detection
    index.ts                        Barrel
    interrupt.ts                    InterruptRule, InterruptRegistry, createInterruptRegistry()
  hypothalamus/                     Homeostatic regulation
    index.ts                        Barrel
    tempo.ts                        TempoConfig discriminated union
    types.ts                        TurnConfig, TurnResult, CycleConfig, CycleResult
    cycle-runner.ts                 runCycle() -- brain/body turn pair
    process-runner.ts               runTurn() -- claude -p in container
    timeout-summarizer.ts           Summarize timed-out turn output
  hippocampus/                      Memory consolidation
    index.ts                        Barrel
    dream.ts                        dream.execute() -- diary + secrets compression
    prompts/                        Dream prompt templates (normal, good, nightmare)
```

## Thalamus -- Sensory Relay

The thalamus translates raw domain events into a format the orchestrator can act on, and derives structured situation summaries from accumulated state.

### EventProcessor

Translates a single domain event into an `EventResult`:

```typescript
interface EventResult {
  category?: EventCategory        // what kind of event this is
  stateUpdate?: (prev: DomainState) => DomainState  // state transition
  context?: DomainContext          // side-channel data (e.g. chat messages)
  log?: () => void                 // logging side effect
}

type EventCategory =
  | { _tag: "Heartbeat"; tick: number }
  | { _tag: "StateChange" }
  | { _tag: "LifecycleReset"; reason: string }
```

The `EventCategory` discriminated union drives the orchestrator's dispatch logic. `Heartbeat` triggers timeout checks. `StateChange` triggers the full decision cycle (classify, evaluate interrupts, plan, spawn). `LifecycleReset` kills the current subagent and clears all plans.

**Tag:** `EventProcessorTag`. Domains provide a `Layer` implementing `EventProcessor`.

### SituationClassifier

Derives a structured summary from the current domain state:

```typescript
interface SituationSummary {
  situation: DomainSituation       // domain-specific enum/type
  headline: string                 // one-line description
  sections: Array<{ id, heading, body }>  // structured detail blocks
  metrics: Record<string, string | number | boolean>  // key-value dashboard
}
```

The orchestrator feeds `SituationSummary` into interrupt evaluation, prompt building, and the console state bar.

**Tag:** `SituationClassifierTag`. Domains provide a `Layer` implementing `SituationClassifier`.

## Amygdala -- Threat Detection

The amygdala evaluates declarative interrupt rules against the current state and situation, producing prioritized alerts.

### InterruptRule

```typescript
interface InterruptRule {
  name: string
  priority: "critical" | "high" | "medium" | "low"
  condition: (state: DomainState, situation: DomainSituation) => boolean
  message: (state: DomainState, situation: DomainSituation) => string
  suggestedAction?: string
  suppressWhenTaskIs?: string      // prevents re-triggering during relevant step
}
```

### InterruptRegistry

Built via `createInterruptRegistry(rules)`, which handles rule walking, suppression, priority sorting, and partitioning:

- `evaluate(state, situation, currentTask?)` -- all firing rules, sorted by priority
- `criticals(state, situation, currentTask?)` -- only critical alerts (trigger replanning)
- `softAlerts(state, situation, currentTask?)` -- non-critical alerts (accumulate for next brain prompt)

Critical alerts cause immediate action: in the state machine, the subagent is killed and `brainInterrupt` replans. In the planned-action engine, the active phase returns `Interrupted`. Soft alerts are batched and surfaced to the brain on its next planning cycle.

**Tag:** `InterruptRegistryTag`. Domains provide a `Layer` built from `createInterruptRegistry()`.

## Hypothalamus -- Homeostatic Regulation

The hypothalamus manages timing and execution of agent turns, keeping the system running at a steady pace.

### TempoConfig

A discriminated union that configures how a domain's execution engine runs:

```typescript
interface TempoBase {
  tickIntervalSec: number          // polling/heartbeat interval
  dreamThreshold: number           // diary line count before compression
}

interface StateMachineTempo extends TempoBase {
  _tag: "StateMachine"
  maxTurns: number                 // event loop turn limit
}

interface PlannedActionTempo extends TempoBase {
  _tag: "PlannedAction"
  maxCycles: number                // brain/body cycles per active phase
  breakDurationMs: number          // rest period between active phases
  breakPollIntervalSec: number     // how often to check for interrupts during break
}
```

`StateMachineTempo` is used by SpaceMolt: an event-driven loop where each domain event is a turn. `PlannedActionTempo` is used by GitHub: a fixed number of brain/body cycles followed by a timed break.

### runCycle

Executes a single brain/body turn pair:

1. Build the brain's input prompt (via caller-provided `buildBrainPrompt`)
2. Run the brain (typically Opus) with a timeout
3. If brain timed out, summarize its partial output
4. Run the body (typically Sonnet) with the brain's output as its prompt
5. If body timed out, summarize its partial output
6. Return `CycleResult` with both results and optional summaries

**Dependencies:** `Claude`, `CommandExecutor`, `CharacterLog`.

### Supporting modules

- `process-runner.ts` (`runTurn`) -- executes `claude -p` inside the Docker container, streams output, handles exit codes
- `timeout-summarizer.ts` -- compresses partial output from a timed-out turn into a usable summary

## Hippocampus -- Memory Consolidation

The hippocampus compresses long-term memory (diary and secrets) to prevent context windows from growing unbounded.

### dream.execute()

Compresses a character's diary and secrets via Opus. The dream type is probabilistic:

- **Normal** (most common) -- straightforward compression
- **Good** (roll >= 94) -- optimistic tone
- **Nightmare** (roll < secretsLines/6, max 15%) -- darker, more paranoid compression

The probability of nightmares scales with the number of secrets a character has accumulated. Each dream type uses different prompt templates from `hippocampus/prompts/`.

The orchestrator triggers dreaming via `runReflection`, which checks the diary line count against `TempoConfig.dreamThreshold`.

**Dependencies:** `Claude`, `CharacterFs`, `CharacterLog`.

## Barrel File Contract

All limbic services are re-exported through `core/limbic/index.ts`. Consumers import from the barrel:

```typescript
import { EventProcessorTag, InterruptRegistryTag, runCycle, dream } from '../limbic'
import type { EventResult, SituationSummary, TempoConfig } from '../limbic'
```

Each subsystem has its own barrel (`thalamus/index.ts`, etc.) that the top-level barrel re-exports from. Internal implementation details (like `process-runner.ts`, `timeout-summarizer.ts`, and dream prompt templates) are not exported -- they are consumed only within their subsystem.

Exported surface by subsystem:

| Subsystem | Types | Values |
|-----------|-------|--------|
| Thalamus | `EventProcessor`, `EventResult`, `EventCategory`, `DomainContext`, `SituationClassifier`, `SituationSummary` | `EventProcessorTag`, `SituationClassifierTag` |
| Amygdala | `InterruptRule`, `InterruptRegistry`, `Alert` | `InterruptRegistryTag`, `createInterruptRegistry` |
| Hypothalamus | `CycleConfig`, `CycleResult`, `TempoConfig`, `TempoBase`, `StateMachineTempo`, `PlannedActionTempo` | `runCycle` |
| Hippocampus | `DreamType`, `DreamInput`, `DreamOutput` | `dream` |

## Data Flow

```
Domain Events (WebSocket, GraphQL poll, etc.)
  |
  v
THALAMUS: EventProcessor.processEvent(event, state)
  |  --> EventResult { category, stateUpdate, context, log }
  |
  |  stateUpdate applied to state ref
  |
  v
THALAMUS: SituationClassifier.summarize(state)
  |  --> SituationSummary { situation, headline, sections, metrics }
  |
  v
AMYGDALA: InterruptRegistry.evaluate(state, situation, currentTask?)
  |  --> Alert[] sorted by priority
  |
  +--[critical]--> Orchestrator kills subagent, replans or returns Interrupted
  |
  +--[soft]-----> Accumulated, fed into next brain prompt
  |
  v
ORCHESTRATOR: plan, spawn subagent, or run brain/body cycle
  |  (consumes TempoConfig for timing parameters)
  |  (calls runCycle for brain/body execution)
  |
  v
HIPPOCAMPUS: dream.execute() (triggered by runReflection when diary exceeds threshold)
  |  --> compressed diary + secrets written back to character files
```

The limbic system is purely reactive. Events flow in, signals flow out. The orchestrator decides what to do with those signals.
