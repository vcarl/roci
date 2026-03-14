# Agent Harness

The harness runs autonomous character-driven sessions inside a shared Docker container, using Claude Code as the agent runtime. An orchestrator on the host manages the session lifecycle: connect to a domain, run brain/body or plan/act/evaluate cycles, and capture all output.

## Repository Structure

This project is a pnpm monorepo with the following packages:

```
packages/core/          (@roci/core)              Core engine, services, logging, utilities
packages/domain-spacemolt/ (@roci/domain-spacemolt) SpaceMolt domain implementation
packages/domain-github/    (@roci/domain-github)    GitHub domain implementation
apps/roci/              (roci)                     CLI, orchestrator runner, setup, domain registry
```

## Architecture

```
apps/roci/src/cli.ts
 +-- runOrchestrator(configs[], domain)              apps/roci/src/orchestrator.ts
     +-- ensureSharedContainer()                      Start/reuse Docker container
     +-- for each character: fork characterLoop()     apps/roci/src/orchestrator.ts
         +-- runPhases(context, phaseRegistry)         packages/core/src/core/phase-runner.ts
             +-- Phase: startup, active, break/social, reflection
                 +-- runStateMachine() or runPlannedAction()
```

### Limbic System

Domain-agnostic subsystems live under `packages/core/src/core/limbic/`, organized by analogy to limbic brain regions:

```
packages/core/src/core/limbic/
 +-- thalamus/         Sensory relay: event processing, situation classification
 |   +-- event-processor.ts    EventProcessor, EventResult, EventCategory
 |   +-- situation-classifier.ts   SituationClassifier, SituationSummary
 +-- amygdala/         Threat detection: interrupt evaluation and alerting
 |   +-- interrupt.ts  InterruptRule, InterruptRegistry, createInterruptRegistry()
 +-- hypothalamus/     Homeostatic regulation: timing, cycle execution
 |   +-- tempo.ts      TempoConfig (StateMachineTempo | PlannedActionTempo)
 |   +-- cycle-runner.ts   runCycle (brain/body turn pair)
 |   +-- process-runner.ts runTurn (claude -p in container)
 |   +-- timeout-summarizer.ts
 +-- hippocampus/      Memory consolidation: dream compression
     +-- dream.ts      dream.execute() -- diary + secrets compression via Opus
```

**Thalamus** -- `EventProcessor` translates raw domain events into `EventResult`, which uses a discriminated union `EventCategory`:

```typescript
type EventCategory =
  | { _tag: "Heartbeat"; tick: number }
  | { _tag: "StateChange" }
  | { _tag: "LifecycleReset"; reason: string }

interface EventResult {
  category?: EventCategory
  stateUpdate?: (prev: DomainState) => DomainState
  context?: DomainContext         // e.g. chatMessages
  log?: () => void
}
```

`SituationClassifier` has a single `summarize()` method returning `SituationSummary`:

```typescript
interface SituationSummary {
  situation: DomainSituation          // domain-specific enum/type
  headline: string
  sections: Array<{ id: string; heading: string; body: string }>
  metrics: Record<string, string | number | boolean>
}
```

**Amygdala** -- `InterruptRegistry` evaluates declarative `InterruptRule`s against current state + situation. Rules have a priority (`critical | high | medium | low`), a condition function, a message function, and optional `suppressWhenTaskIs` for deduplication. Critical alerts trigger immediate replanning; soft alerts accumulate and feed into the next brain prompt.

**Hypothalamus** -- `TempoConfig` is a discriminated union governing cycle timing:

```typescript
interface StateMachineTempo extends TempoBase {
  _tag: "StateMachine"
  maxTurns: number
}

interface PlannedActionTempo extends TempoBase {
  _tag: "PlannedAction"
  maxCycles: number
  breakDurationMs: number
  breakPollIntervalSec: number
}
```

`runCycle` runs a single brain/body turn pair: build brain prompt, run brain (Opus) with timeout, run body (Sonnet) with brain output as prompt, summarize on timeout.

**Hippocampus** -- `dream.execute()` compresses diary and secrets via Opus. Dream type is probabilistic (normal/good/nightmare), selected based on secrets line count.

### Domain Services

All domain knowledge is injected via 6 Effect service layers, provided as a `DomainBundle`. See `docs/DOMAIN_GUIDE.md` for full documentation.

| Service | Tag | Role |
|---------|-----|------|
| **EventProcessor** | `EventProcessorTag` | Maps raw domain events to `EventResult` with `EventCategory` discriminated union |
| **SituationClassifier** | `SituationClassifierTag` | `summarize(state)` -- structured `SituationSummary` with headline, sections, metrics |
| **InterruptRegistry** | `InterruptRegistryTag` | Declarative interrupt rules with priority, condition, message, `suppressWhenTaskIs` |
| **StateRenderer** | `StateRendererTag` | Snapshots, rich snapshots, diffs, console state bar |
| **PromptBuilder** | `PromptBuilderTag` | Assembles all LLM prompts (plan, interrupt, evaluate, subagent, brainPrompt) |
| **SkillRegistry** | `SkillRegistryTag` | Step completion logic -- task types, instructions, deterministic checks |

### Phase System

Sessions progress through a sequence of named phases. Each phase returns a `PhaseResult`: `Continue` (with next phase name), `Restart`, or `Shutdown`. The phase runner drives the sequence.

`PhaseContext` carries the character config, container ID, container env, an optional `ConnectionState` (event queue + initial state), optional `phaseData` for inter-phase threading, and the `DomainBundle`.

`PhaseRegistry` lists available phases and identifies the initial phase.

## Execution Engines

### runStateMachine -- Plan/Act/Evaluate

Used by SpaceMolt. Reads events from a queue, drives a brain + subagent cycle with planning, execution, and evaluation steps.

```
Queue.take(event)
 |
 v
eventProcessor.processEvent(event, state) --> EventResult
 +-- apply stateUpdate
 +-- run log side effect
 +-- accumulate context (chat messages)
 |
 v
dispatch on EventCategory:
 +-- LifecycleReset --> kill subagent, clear plan, reset mode
 +-- StateChange   --> { decision cycle }
 +-- Heartbeat     --> { tick cycle }
```

**Decision cycle** (on StateChange):

```
classifier.summarize(state)
 |
interrupts.evaluate(state, situation, currentTask)
 +-- criticals --> kill subagent, brainInterrupt --> new Plan
 +-- soft alerts --> accumulate for next brain prompt
 |
poll subagent fiber
 +-- done --> evaluateCompletedSubagent --> step++ or clear plan
 |
maybeRequestPlan   (no plan, no subagent)
 +-- reads diary, background, values
 +-- brainPlan.execute() --> LLM --> Plan{steps[]}
 |
maybeSpawnSubagent  (plan exists, no fiber)
 +-- runGenericSubagent() --> Docker exec --> Claude Code
```

**Tick cycle** (on Heartbeat):

```
checkMidRun   (timeout exceeded --> kill fiber, step++)
poll subagent fiber (done --> evaluate)
planAndSpawn
```

The state machine supports lifecycle hooks (`shouldExit`, `onInterrupt`, `onReset`, `onProcedureComplete`) and an exit signal deferred for clean shutdown.

### Brain/Body Cycles

Runs up to `maxCycles` brain/body cycles per active phase. Consumes 5 of 6 domain services (not SkillRegistry).

```
for cycle in 0..maxCycles:
  1. Drain event queue, apply state updates
  2. classifier.summarize(state)
  3. renderer.logStateBar() + stateDiff from previous cycle
  4. interrupts.evaluate() --> critical? return Interrupted
  5. Read identity (background, values, diary)
  6. promptBuilder.brainPrompt({summary, diary, background, values, cycle, softAlerts, stateDiff})
  7. runCycle():
     a. Brain (Opus, 8 min timeout) --> directives
     b. Body (Sonnet, 15 min timeout) receives brain output as prompt
  8. Update snapshot for next cycle's diff

Returns: Completed{finalState, cyclesRun} | Interrupted{finalState, cyclesRun, criticals}
```

### runBreak

Sleeps for `breakDurationMs`, polling the event queue every `breakPollIntervalSec`. On each state change, evaluates interrupt rules. If a critical fires, returns `Interrupted` early. Otherwise returns `Completed`.

### runReflection

Checks diary line count against `dreamThreshold`. If exceeded, calls `dream.execute()` to compress diary and secrets.

## Adding an Interrupt Rule

Add to the rules array in the domain's `interrupts.ts` (e.g. `packages/domain-spacemolt/src/interrupts.ts`):

```typescript
{ name: "fuel_emergency", priority: "critical",
  condition: (s, sit) => sit.flags.lowFuel && sit.type !== SituationType.Docked,
  message: (s) => `Fuel critical (${s.ship.fuel}). Dock immediately.`,
  suppressWhenTaskIs: "refuel" }
```

`createInterruptRegistry(rules)` builds an `InterruptRegistry` that handles rule walking, suppression, sorting, and partitioning into `criticals()` and `softAlerts()`.

## Domain Comparison

| | SpaceMolt | GitHub |
|---|-----------|--------|
| **Engine** | `runStateMachine` (plan/act/evaluate per event) | `runPlannedAction` (up to 3 brain/body cycles per active phase) |
| **Phases** | startup, active, social, reflection | startup, active, break, reflection |
| **Brain** | Opus plans steps, Haiku/Sonnet executes each step | Opus writes directives, Sonnet executes full session |
| **Polling** | WebSocket events | Single GraphQL query per repo per poll |
| **Interrupts** | Evaluated on every state change and tick | Evaluated at start of each cycle + during break |
| **Reports** | Step timing history + diffs | Body output (brain sees previous cycle results via diary) |

## Sequence Diagram: Subagent Execution

```
  Orchestrator          Docker Container          Log Files        Console
  (host)                (roci-crew)
  |                     |                         |                |
  | docker exec -i      |                         |                |
  | -e OAUTH_TOKEN=...  |                         |                |
  |-------------------->|                         |                |
  |  stdin: prompt      |                         |                |
  |                     | run-step.sh             |                |
  |                     | cd /work/players/<name> |                |
  |                     | claude -p --stream-json |                |
  |                     |         |               |                |
  |                     |         | $ sm status   |                |
  |                     |         |---------> ... |                |
  |                     |         |<--------- ... |                |
  |                     |         |               |                |
  |<====================| stdout: stream-json lines                |
  |  (each line)        |         |               |                |
  |- - - - - - - - - - - - - - - - - - - - - - - ->|                |
  |  log.raw(line)      |         |       stream.jsonl (verbatim)  |
  |                     |         |               |                |
  |  parseStreamJson(line)        |               |                |
  |  +-- ok --> demuxEvent        |               |                |
  |  |   +-- assistant:text - - - - - - - - - - - - - - - - - - - >|
  |  |   +-- assistant:tool_use - - - - - - - - - - - - - - - - - >|
  |  |   +-- user:tool_result - - - - - - - - - - - - - - - - - - >|
  |  |   +-- result - - - - - - - - - - - - - - - - - - - - - - - >|
  |  +-- parse fail - - - - - - - - - - - - - - - - - - - - - - - >|
  |                               |               |  [name:raw]    |
  |                               |               |                |
  |<====================| stream ends             |                |
  |                     |         |               |                |
  |  waitForExit        |         |               |                |
  |  +-- join stderr fiber        |               |                |
  |  +-- get exit code  |         |               |                |
  |  +-- exitCode != 0 - - - - - - - - - - - - - - - - - - - - - >|
  |  |   fail with ClaudeError    |               |  [name:error]
  |  +-- exitCode == 0  |         |               |                |
  |     return text     |         |               |                |
```

## Container Layout

Single shared container `roci-crew`, all characters isolated via `--add-dir`.

**Volume mounts:**

| Host Path | Container Path | Access | Domain |
|-----------|---------------|--------|--------|
| `players/` | `/work/players` | RW | Both |
| `repos/` | `/work/repos` | RW | GitHub |
| `shared-resources/workspace/` | `/work/shared/workspace` | RW | SpaceMolt |
| `shared-resources/spacemolt-docs/` | `/work/shared/spacemolt-docs` | RW | SpaceMolt |
| `docs/` | `/work/shared/docs` | RW | Both |
| `shared-resources/sm-cli/` | `/work/sm-cli` | RW | SpaceMolt |
| `.claude/` | `/work/.claude` | RO | Both |
| `.devcontainer/` | `/opt/devcontainer` | RO | Both |
| `scripts/` | `/opt/scripts` | RO | Both |

**What the subagent sees** (via `--add-dir` in `run-step.sh`):

| Path | Purpose |
|------|---------|
| `/work/players/<name>/` | CWD -- credentials, background, diary, secrets, values |
| `/work/shared/` | Shared workspace, game docs |
| `/work/sm-cli/` | sm CLI source |

**What the subagent doesn't see:**

| Path | Purpose |
|------|---------|
| `/opt/scripts/` | run-step.sh |
| `/opt/devcontainer/` | Dockerfile, firewall script |

## Log Files

Per character at `players/<name>/logs/`:

| File | Contents | Written by |
|------|----------|-----------|
| `stream.jsonl` | Every raw stdout line, verbatim | `log.raw()` |
| `thoughts.jsonl` | Assistant text blocks, dream events, brain decisions | `log.thought()` |
| `actions.jsonl` | Tool use, tool results, subagent lifecycle | `log.action()` |
| `words.jsonl` | sm chat/forum commands (social actions) | `log.word()` |

## Console Output

All events printed type-tagged with timestamp and character name:

```
18:04:37 [test-pilot:assistant:text] I'll check the market prices first...
18:04:37 test-pilot: "I'll check the market prices first..."
18:04:38 [test-pilot:assistant:tool_use] Bash: sm market
18:04:38   $ sm market
18:04:39 [test-pilot:user:tool_result] Iron Ore: 5cr/unit (3 buy orders)...
18:04:39   > Iron Ore: 5cr/unit (3 buy orders)...
18:04:45 [test-pilot:result] ok:
18:04:45 [test-pilot:stderr] (if any stderr output)
```

## Commands

```bash
./roci start <character> [character...]    # Build image, start orchestrator
./roci start <char> --tick-interval 60     # Custom tick interval (default 30s)
./roci stop                                # Stop the shared container
./roci pause                               # Pause the shared container
./roci resume                              # Resume the shared container
./roci destroy                             # Remove the shared container
./roci status                              # Show container status
./roci logs <character>                    # Show recent thoughts
```

## Key Files

### Core — `packages/core/` (@roci/core)

| File | Role |
|------|------|
| `packages/core/src/core/orchestrator/state-machine.ts` | Plan/act/evaluate event loop |
| `packages/core/src/core/orchestrator/planned-action.ts` | Brain/body cycle engine, runBreak, runReflection |
| `packages/core/src/core/orchestrator/planning/brain.ts` | Brain functions: plan, interrupt, evaluate (Opus) |
| `packages/core/src/core/orchestrator/planning/subagent-manager.ts` | Build prompt, run in container, handle exit |
| `packages/core/src/core/orchestrator/lifecycle.ts` | LifecycleHooks (shouldExit, onInterrupt, onReset) |
| `packages/core/src/core/limbic/thalamus/event-processor.ts` | EventProcessor, EventResult, EventCategory |
| `packages/core/src/core/limbic/thalamus/situation-classifier.ts` | SituationClassifier, SituationSummary |
| `packages/core/src/core/limbic/amygdala/interrupt.ts` | InterruptRule, InterruptRegistry, createInterruptRegistry() |
| `packages/core/src/core/limbic/hypothalamus/tempo.ts` | TempoConfig (StateMachineTempo, PlannedActionTempo) |
| `packages/core/src/core/limbic/hypothalamus/cycle-runner.ts` | runCycle -- single brain/body turn pair |
| `packages/core/src/core/limbic/hypothalamus/process-runner.ts` | `runTurn` -- primary domain execution path: claude -p in container with tool access |
| `packages/core/src/core/limbic/hippocampus/dream.ts` | Dream compression (diary + secrets) |
| `packages/core/src/core/phase.ts` | Phase, PhaseContext, PhaseResult, PhaseRegistry |
| `packages/core/src/core/phase-runner.ts` | Runs phases in sequence, handles Continue/Restart/Shutdown |
| `packages/core/src/core/domain-bundle.ts` | DomainBundle (6 service layers) + DomainConfig |
| `packages/core/src/core/prompt-builder.ts` | PromptBuilder interface (plan, interrupt, evaluate, subagent, brainPrompt) |
| `packages/core/src/core/state-renderer.ts` | StateRenderer interface |
| `packages/core/src/core/skill.ts` | Skill + SkillRegistry interface |

### GitHub domain — `packages/domain-github/` (@roci/domain-github)

| File | Role |
|------|------|
| `packages/domain-github/src/phases.ts` | Phase registry: startup, active (runPlannedAction), break (runBreak), reflection |
| `packages/domain-github/src/interrupts.ts` | Declarative interrupt rules (CI failing, review requested, untriaged issues, stale PRs) |
| `packages/domain-github/src/github-client.ts` | GraphQL polling, single query per repo, token validation |
| `packages/domain-github/src/brain-system-prompt.md` | Brain (Opus) system prompt |
| `packages/domain-github/src/body-system-prompt.md` | Body (Sonnet) system prompt |
| `packages/domain-github/src/prompt-helpers.ts` | State summary renderer for brain prompt |

### SpaceMolt domain — `packages/domain-spacemolt/` (@roci/domain-spacemolt)

| File | Role |
|------|------|
| `packages/domain-spacemolt/src/config.ts` | DomainConfig factory (mounts, image, setup) |
| `packages/domain-spacemolt/src/index.ts` | Domain bundle (all 6 service layers) |
| `packages/domain-spacemolt/src/phases.ts` | Phase registry: startup, active (runStateMachine), social, reflection |
| `packages/domain-spacemolt/src/interrupts.ts` | Declarative interrupt rules via createInterruptRegistry() |
| `packages/domain-spacemolt/src/situation.ts` | SituationClassifier -- summarize() with structured SituationSummary |
| `packages/domain-spacemolt/src/renderer.ts` | State snapshots, diffs, console bar |
| `packages/domain-spacemolt/src/prompt-builder.ts` | All LLM prompt assembly |
| `packages/domain-spacemolt/src/event-processor.ts` | Maps WS GameEvents to EventResults |
| `packages/domain-spacemolt/src/game-socket-impl.ts` | WebSocket connection, reconnection, event queue |
| `docs/DOMAIN_GUIDE.md` | Guide for building new domains |

### CLI and orchestrator — `apps/roci/` (roci)

| File | Role |
|------|------|
| `apps/roci/src/cli.ts` | CLI commands and service wiring |
| `apps/roci/src/orchestrator.ts` | Container lifecycle, fork character fibers |
| `apps/roci/src/domains/registry.ts` | Domain registry |

### Services and logging — `packages/core/` (@roci/core)

| File | Role |
|------|------|
| `packages/core/src/services/Claude.ts` | Host-only `invoke` for orchestrator-internal tasks (memory, summarization) |
| `packages/core/src/services/ProjectRoot.ts` | Project root path service |
| `packages/core/src/services/CharacterFs.ts` | Character file system operations |
| `packages/core/src/services/Docker.ts` | Docker container management |
| `packages/core/src/logging/log-demux.ts` | Raw capture, parse, route to logs + console |
| `packages/core/src/logging/log-writer.ts` | CharacterLog service (JSONL append) |
| `packages/core/src/logging/console-renderer.ts` | Type-tagged + narrative console output |

### Infrastructure

| File | Role |
|------|------|
| `scripts/run-step.sh` | In-container: cd to player dir, exec claude -p |
| `.devcontainer/Dockerfile` | Container image: node20, claude-code, firewall |
| `.devcontainer/init-firewall.sh` | iptables whitelist for allowed domains |
