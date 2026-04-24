# Limbic System

The limbic system is a passive sensing and signaling layer that sits between raw domain events and the channel session orchestrator. It handles data ingestion, situation classification, threat detection, session execution, and memory consolidation. It does not orchestrate -- the orchestrator layer consumes limbic services to make decisions.

The name comes from the biological limbic system. Each subsystem maps to a brain region that performs an analogous function: the thalamus relays sensory input, the amygdala detects threats, the hypothalamus manages execution, and the hippocampus consolidates memory. These are metaphors for code organization, not a neuroscience simulation.

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
  hypothalamus/                     Session execution and regulation
    index.ts                        Barrel
    session-runner.ts               runSession() -- spawns claude --channels in container
    runtime.ts                      Runtime binary selection (claude vs opencode)
    tempo.ts                        TempoConfig discriminated union
    types.ts                        TurnConfig, TurnResult, CycleConfig, CycleResult
    cycle-runner.ts                 runCycle() -- brain/body turn pair (legacy path)
    process-runner.ts               runTurn() -- claude -p in container (legacy path)
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

The `EventCategory` discriminated union drives orchestrator dispatch. `Heartbeat` triggers timeout checks. `StateChange` triggers full state classification and interrupt evaluation. `LifecycleReset` kills the current session and clears plans.

The `alert` field is new: when set, the orchestrator immediately pushes it to the running channel session before the next tick.

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
  suppressWhenTaskIs?: string
}
```

### InterruptRegistry

Built via `createInterruptRegistry(rules)`, which handles rule walking, suppression, priority sorting, and partitioning:

- `evaluate(state, situation, currentTask?)` -- all firing rules, sorted by priority
- `criticals(state, situation, currentTask?)` -- only critical alerts
- `softAlerts(state, situation, currentTask?)` -- non-critical alerts

Critical alerts cause the channel session to be killed and `Interrupted` returned. Soft alerts are included in the next channel event push so the running session can factor them into its work.

**Tag:** `InterruptRegistryTag`. Domains provide a `Layer` built from `createInterruptRegistry()`.

## Hypothalamus -- Session Execution

The hypothalamus manages the execution of agent sessions inside Docker containers.

### Session Runner

`runSession(config)` is the primary execution mechanism. It:

1. Writes `.mcp.json` with channel server configuration
2. Builds `claude --channels` CLI args (or `opencode` for non-Claude models)
3. Starts the process via `docker exec` with environment variables and OAuth token
4. Forks concurrent fibers for:
   - **stderr draining** -- prevents pipe blocking
   - **stdout streaming** -- parses stream-json, emits unified events to CharacterLog
   - **activity tailing** -- monitors `activity.log` for subagent tool calls
   - **exit monitoring** -- watches process exit code
   - **session management** -- races timeout vs. process exit, reads `session-result.json`
5. Returns a `SessionHandle` immediately

```typescript
interface SessionHandle {
  pushEvent(content: string, meta?: Record<string, string>): Effect<void>
  join: Effect<SessionResult>
  interrupt: Effect<void>
}

interface SessionResult {
  reason: "completed" | "unachievable" | "killed" | "crashed"
  summary?: string
  durationMs: number
}
```

### Runtime Selection

`runtimeBinary(model)` determines whether to use `claude` or `opencode` based on the model string. `runtimeBaseArgs(runtime, model)` builds the appropriate CLI arguments.

### Legacy Execution Path

`runCycle()` and `runTurn()` still exist for backward compatibility. `runCycle` executes a single brain/body turn pair (brain plans, body executes). `runTurn` runs `claude -p` inside the Docker container. These are used by the older planned-action and state machine engines.

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

All limbic services are re-exported through `core/limbic/index.ts`:

```typescript
import { EventProcessorTag, InterruptRegistryTag, dream } from '../limbic'
import type { EventResult, SituationSummary, SessionHandle } from '../limbic'
```

Exported surface by subsystem:

| Subsystem | Types | Values |
|-----------|-------|--------|
| Thalamus | `EventProcessor`, `EventResult`, `EventCategory`, `DomainContext`, `SituationClassifier`, `SituationSummary` | `EventProcessorTag`, `SituationClassifierTag` |
| Amygdala | `InterruptRule`, `InterruptRegistry`, `Alert` | `InterruptRegistryTag`, `createInterruptRegistry` |
| Hypothalamus | `SessionHandle`, `SessionResult`, `CycleConfig`, `CycleResult`, `TempoConfig` | `runSession`, `runCycle` |
| Hippocampus | `DreamType`, `DreamInput`, `DreamOutput` | `dream` |

Internal modules (`process-runner.ts`, `timeout-summarizer.ts`, dream prompt templates) are not exported.
