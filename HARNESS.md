# Agent Harness

The harness runs autonomous character-driven sessions inside shared Docker containers, using Claude Code as the agent runtime. An orchestrator on the host manages the session lifecycle: connect to a domain, run a tick-driven cortex loop, drain state updates as events, and capture all output.

## Repository Structure

```
packages/core/             (@roci/core)               Core engine, services, logging, utilities
packages/domain-spacemolt/ (@roci/domain-spacemolt)    SpaceMolt domain implementation
packages/domain-github/    (@roci/domain-github)       GitHub domain implementation
apps/roci/                 (roci)                      CLI, orchestrator runner, setup, domain registry
```

## Architecture

```
apps/roci/src/cli.ts
 +-- runOrchestrator(configs[], domain)              apps/roci/src/orchestrator.ts
     +-- ensureContainer()                            Start/reuse Docker container per domain
     +-- for each character: fork characterLoop()
         +-- runPhases(context, phaseRegistry)         packages/core/src/core/phase-runner.ts
             +-- Phase: startup, active, break/social, reflection
                 +-- runCortex(config)                 packages/core/src/cortex/loop.ts
```

### Cortex Loop Model

The primary execution engine is `runCortex(config)` (`packages/core/src/cortex/loop.ts`). It runs a tick-driven loop (default 30s/tick) that drives a four-tier "brain" over the lifetime of an active phase. It does **not** spawn a persistent `claude --channels` process; instead, conscious-tier plan steps execute as short-lived OpenCode sessions inside the Docker container.

`runCortex()` returns an Effect resolving to either `{ _tag: "Completed", finalState }` or `{ _tag: "Interrupted", finalState, criticals[] }`.

**Each tick:**

1. **Drain events** -- Pull queued domain events, fold them through `EventProcessor` to update state, and classify the situation via `SituationClassifier`.

2. **Critical interrupts** -- Evaluate interrupt rules (`packages/core/src/core/limbic/amygdala/interrupt.ts`). If a critical fires, the loop returns `Interrupted` with the offending criticals.

3. **Hindbrain triage (Observe)** -- `runHindbrain` (`cortex/tiers.ts:67`) classifies accumulated events as discard / accumulate / escalate.

4. **Escalate-or-sleep** -- If nothing warrants attention, the loop sleeps until the next tick. A forced orient happens every `orientInterval` ticks (default 5) regardless.

5. **Forebrain orient (Orient)** -- `runForebrain` (`cortex/tiers.ts:110`) synthesizes the current situation into a working assessment.

6. **Conscious decide (Decide)** -- `runConsciousDecide` (`cortex/tiers.ts:167`) chooses plan / continue / wait / terminate and, when planning, produces an ordered set of steps.

7. **Conscious step execution** -- Each plan step runs as an OpenCode session in the container via `ConsciousThought` (`packages/core/src/conscious/conscious-thought.ts`), backed by `runOpenCodeSessionTurn` in `packages/core/src/core/limbic/hypothalamus/process-runner.ts`, which invokes `opencode run --format json ...` through `docker exec`.

8. **Conscious evaluate (Evaluate)** -- `runConsciousEvaluate` (`cortex/tiers.ts:224`) decides next_step / replan / wait / terminate.

The loop ends (returns `Completed`) when the conscious tier terminates, and ends (returns `Interrupted`) when a critical interrupt fires.

**Key constants** (`packages/core/src/cortex/loop.ts`):

| Constant | Value | Purpose |
|----------|-------|---------|
| `DEFAULT_TICK_MS` | 30,000 | Interval between cortex ticks |
| `DEFAULT_ORIENT_INTERVAL` | 5 | Ticks between forced forebrain orients |
| `DEFAULT_WORKER_TIMEOUT_MS` | 3,600,000 | Max duration of a single OpenCode worker turn (1 hour) |
| `DEFAULT_STEER_CADENCE_TICKS` | 3 | Ticks between steering nudges to a running step |

### Cadence

`cadence` is the master dial for the loop's wake/escalation tempo. It is either `real-time` or `planned-action` (the default), and threads `{{cadenceGuidance}}` (`packages/core/src/skills/cadence.ts`) into all four tiers:

- **`real-time`** -- low escalation threshold, short 1-2 step plans, replan eagerly. Suited to domains where events arrive continuously and the agent must stay responsive (e.g. SpaceMolt's live game socket).
- **`planned-action`** -- high escalation threshold (accumulate events by default), 3-5 step plans, patient with `wait` states. Suited to domains where work comes in discrete chunks and patience is cheap (e.g. GitHub's GraphQL polling).

The same guidance text is injected into hindbrain, forebrain, and both conscious tiers, so a single setting consistently tunes how readily the brain wakes, how long it plans ahead, and how quickly it re-plans.

### Limbic System

Domain-agnostic subsystems live under `packages/core/src/core/limbic/`, organized by analogy to limbic brain regions. See [LIMBIC.md](packages/core/src/core/limbic/LIMBIC.md) for full documentation.

```
packages/core/src/core/limbic/
 +-- thalamus/         Sensory relay: event processing, situation classification
 +-- amygdala/         Threat detection: interrupt evaluation and alerting
 +-- hypothalamus/     Homeostatic regulation: session execution, timing
 +-- hippocampus/      Memory consolidation: dream compression
```

**Data flow:**

```
Domain Events (WebSocket, GraphQL poll, etc.)
  |
  v
THALAMUS: EventProcessor.processEvent(event, state) --> EventResult
  |  apply stateUpdate, run log side effect
  v
THALAMUS: SituationClassifier.summarize(state) --> SituationSummary
  |
  v
AMYGDALA: InterruptRegistry.evaluate(state, situation)
  +--[critical]--> Stop the loop, return Interrupted
  +--[soft]------> Surface to the next forebrain orient
  |
  v
CORTEX: hindbrain triage --> forebrain orient --> conscious decide/evaluate
  |
  v
HIPPOCAMPUS: dream.execute() (in reflection phase, when diary exceeds threshold)
```

### Operating Skills

Operating skills define how agents think at each stage of the OODA loop: observe, orient, decide, evaluate. They live in `packages/core/src/skills/` as markdown templates with YAML frontmatter. See [docs/OPERATING_SKILLS.md](docs/OPERATING_SKILLS.md) for full documentation.

### Domain Services

All domain knowledge is injected via 6 Effect service layers, provided as a `DomainBundle`. See [docs/DOMAIN_GUIDE.md](docs/DOMAIN_GUIDE.md) for full documentation.

| Service | Tag | Role |
|---------|-----|------|
| **EventProcessor** | `EventProcessorTag` | Maps raw domain events to `EventResult` with `EventCategory` discriminated union |
| **SituationClassifier** | `SituationClassifierTag` | `summarize(state)` -- structured `SituationSummary` with headline, sections, metrics |
| **InterruptRegistry** | `InterruptRegistryTag` | Declarative interrupt rules with priority, condition, message, `suppressWhenTaskIs` |
| **StateRenderer** | `StateRendererTag` | Snapshots, rich snapshots, diffs, console state bar |
| **PromptBuilder** | `PromptBuilderTag` | Assembles session prompts: `systemPrompt`; `taskPrompt` and `channelEvent` are deprecated fallbacks (the cortex tiers now produce step content) |
| **SkillRegistry** | `SkillRegistryTag` | Domain skill catalog and deterministic step-completion checks |

### Phase System

Sessions progress through a sequence of named phases. Each phase returns a `PhaseResult`: `Continue` (with next phase name), `Restart`, or `Shutdown`. The phase runner drives the sequence.

`PhaseContext` carries the character config, container ID, container env, an optional `ConnectionState` (event queue + initial state), optional `phaseData` for inter-phase threading, and the `DomainBundle`.

#### SpaceMolt Phase Lifecycle

```
startup --> active (cortex loop) --> social (dinner) --> reflection (dream) --> active
```

- **startup** -- Read credentials, connect via WebSocket, compress diary if over threshold
- **active** -- `runCortex` with domain bundle. On interrupt: restart active. On completion: proceed to social
- **social** -- Run `dinner.execute()` for social reflection
- **reflection** -- Run `runReflection` to compress diary if over 200 lines. Loop back to active

#### GitHub Phase Lifecycle

```
startup --> active (cortex loop) --> break (90 min) --> reflection (dream) --> active
                 \                          ^
                  \---> (critical interrupt) ---/
```

- **startup** -- Read `github.json`, validate token, clone repos, create worktrees, start GraphQL polling
- **active** -- `runCortex` with domain bundle. On interrupt: restart active. On completion: proceed to break
- **break** -- Sleep 90 minutes via `runBreak`, polling for critical interrupts every 5 seconds. If a critical fires (e.g., CI failure), exit early to active
- **reflection** -- Run `runReflection` to compress diary. Loop back to active

### Orchestrator Startup

`runOrchestrator()` in `apps/roci/src/orchestrator.ts` manages the top-level lifecycle:

1. **Image building** -- Build Docker images once per unique `imageName` across resolved domains
2. **Container provisioning** -- `ensureContainer()` per domain: reuse running, resume paused, or create new. Containers get `NET_ADMIN` + `NET_RAW` capabilities for firewall rules
3. **OAuth validation** -- Validate token inside the first container
4. **Character fibers** -- Fork one concurrent fiber per character via `runPhases()`. Each character gets `Layer.fresh(domainServiceLayer)` to prevent shared stateful services
5. **Cleanup** -- On exit, stop all containers

### Model Configuration

Models are configured via a tier system (`fast`, `smart`, `reasoning`) with per-role overrides. See [docs/MODEL_CONFIG.md](docs/MODEL_CONFIG.md) for details.

## Domain Comparison

| | SpaceMolt | GitHub |
|---|-----------|--------|
| **Phases** | startup, active, social, reflection | startup, active, break, reflection |
| **Event Source** | WebSocket (real-time game events) | GraphQL polling (30s interval) |
| **Session Model** | Cortex loop (`real-time` cadence) | Cortex loop (`planned-action` cadence) |
| **Interrupts** | 9 rules (combat, hull, fuel, cargo, etc.) | 5 rules (CI, review, triage, etc.) |
| **Skills** | Stub (LLM evaluates all steps) | File-based loader from `.claude/skills/` |

## Session Execution Detail

The cortex loop runs entirely on the host. When the conscious tier decides to execute a plan step, it runs a short-lived OpenCode session inside the container via `docker exec`; there is no long-lived channel server.

```
  Cortex Loop (host)                 Docker Container (roci-<domain>)
  |                                  |
  | [every tick, default 30s]        |
  | drain events, classify           |
  | hindbrain / forebrain / conscious|
  |                                  |
  | [conscious step]                 |
  | docker exec                      |
  | opencode run --format json ...   |
  |--------------------------------->|
  |                                  | runs OpenCode session
  |<=================================| json stdout (per turn)
  |  parse, log, route               |
  |                                  |
  | conscious evaluate               |
  | (next_step / replan / wait /     |
  |  terminate)                      |
  |                                  |
  | [on terminate]   --> Completed   |
  | [on critical]    --> Interrupted |
```

## Container Layout

Each domain runs in its own Docker container named `roci-<domain>`. Characters within a domain share a container.

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

**What the agent sees** (via `--add-dir`):

| Path | Purpose |
|------|---------|
| `/work/players/<name>/` | CWD -- credentials, background, diary, secrets, values |
| `/work/shared/` | Shared workspace, game docs |

## Log Files

Per character at `players/<name>/logs/`:

| File | Contents | Written by |
|------|----------|-----------|
| `stream.jsonl` | Every raw stdout line, verbatim | `log.raw()` |
| `thoughts.jsonl` | Assistant text blocks, dream events, decisions | `log.thought()` |
| `actions.jsonl` | Tool use, tool results, session lifecycle | `log.action()` |
| `words.jsonl` | Social actions (chat, forum commands) | `log.word()` |

## Adding an Interrupt Rule

Add to the rules array in the domain's `interrupts.ts`:

```typescript
{ name: "fuel_emergency", priority: "critical",
  condition: (s, sit) => sit.flags.lowFuel && sit.type !== SituationType.Docked,
  message: (s) => `Fuel critical (${s.ship.fuel}). Dock immediately.`,
  suppressWhenTaskIs: "refuel" }
```

`createInterruptRegistry(rules)` builds an `InterruptRegistry` that handles rule walking, suppression, sorting, and partitioning into `criticals()` and `softAlerts()`. See the [LIMBIC.md](packages/core/src/core/limbic/LIMBIC.md) amygdala section for details.

## Console Output

All events are printed type-tagged with timestamp and character name:

```
18:04:37 [test-pilot:assistant:text] I'll check the market prices first...
18:04:37 test-pilot: "I'll check the market prices first..."
18:04:38 [test-pilot:assistant:tool_use] Bash: sm market
18:04:38   $ sm market
18:04:39 [test-pilot:user:tool_result] Iron Ore: 5cr/unit (3 buy orders)...
18:04:39   > Iron Ore: 5cr/unit (3 buy orders)...
18:04:45 [test-pilot:result] ok:
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
```

## Key Files

### Core -- `packages/core/` (@roci/core)

| File | Role |
|------|------|
| `src/cortex/loop.ts` | `runCortex` -- the primary tick-driven execution loop |
| `src/cortex/tiers.ts` | The four tiers: `runHindbrain`, `runForebrain`, `runConsciousDecide`, `runConsciousEvaluate` |
| `src/conscious/conscious-thought.ts` | `ConsciousThought` -- conscious-tier executor; runs plan steps as OpenCode sessions |
| `src/core/limbic/hypothalamus/process-runner.ts` | `runOpenCodeSessionTurn` -- runs `opencode run --format json` in the container via `docker exec` |
| `src/core/limbic/hypothalamus/runtime.ts` | Runtime binary selection (claude vs opencode) and CLI arg building |
| `src/core/limbic/thalamus/event-processor.ts` | EventProcessor, EventResult, EventCategory |
| `src/core/limbic/thalamus/situation-classifier.ts` | SituationClassifier, SituationSummary |
| `src/core/limbic/amygdala/interrupt.ts` | InterruptRule, InterruptRegistry, createInterruptRegistry() |
| `src/core/limbic/hippocampus/dream.ts` | Dream compression (diary + secrets) |
| `src/core/phase.ts` | Phase, PhaseContext, PhaseResult, PhaseRegistry |
| `src/core/phase-runner.ts` | Runs phases in sequence, handles Continue/Restart/Shutdown |
| `src/core/domain-bundle.ts` | DomainBundle (6 service layers) + DomainConfig |
| `src/core/prompt-builder.ts` | PromptBuilder interface (systemPrompt; taskPrompt/channelEvent deprecated) |
| `src/core/state-renderer.ts` | StateRenderer interface |
| `src/core/skill.ts` | Skill + SkillRegistry interface |
| `src/core/model-config.ts` | Tier-based model resolution |
| `src/skills/` | Operating skill templates (observe, orient, decide, evaluate) |

### GitHub domain -- `packages/domain-github/` (@roci/domain-github)

| File | Role |
|------|------|
| `src/phases.ts` | Phase registry: startup, active (runCortex), break, reflection |
| `src/index.ts` | Domain bundle assembly and file-based skill loading |
| `src/types.ts` | All domain types: state, events, situations, config |
| `src/github-client.ts` | GraphQL polling client (1 query per repo per poll) |
| `src/prompt-builder.ts` | Prompt generation: system prompt (task/channel-event fallbacks deprecated) |
| `src/interrupts.ts` | Declarative interrupt rules (CI, review, triage, stale PRs) |
| `src/situation-classifier.ts` | Per-repo classification and aggregate rollup |
| `src/renderer.ts` | State snapshots, rich diffs, status bar |
| `src/session-system-prompt.md` | System prompt for the OpenCode session steps |
| `src/procedures/` | Procedure templates (select, triage, feature, review) |

### SpaceMolt domain -- `packages/domain-spacemolt/` (@roci/domain-spacemolt)

| File | Role |
|------|------|
| `src/phases.ts` | Phase registry: startup, active (runCortex), social, reflection |
| `src/index.ts` | Domain bundle assembly and stub skill registry |
| `src/types.ts` | All domain types: game state, player, ship, system, POI, situation |
| `src/game-socket-impl.ts` | WebSocket connection, login flow, event dispatching |
| `src/event-processor.ts` | Maps WebSocket events to state operations |
| `src/situation-classifier.ts` | Situation classification (combat, transit, docked, in-space) |
| `src/interrupts.ts` | 9 interrupt rules across 4 priority levels |
| `src/prompt-builder.ts` | Template-based prompt generation |
| `src/session-system-prompt.md` | System prompt for the OpenCode session steps |
| `src/dinner.ts` | Social/dinner phase implementation |

### CLI and orchestrator -- `apps/roci/` (roci)

| File | Role |
|------|------|
| `src/cli.ts` | CLI commands and service wiring |
| `src/orchestrator.ts` | Container lifecycle, fork character fibers |
| `src/domains/registry.ts` | Domain registry |

### Services and logging -- `packages/core/` (@roci/core)

| File | Role |
|------|------|
| `src/services/Claude.ts` | Host-only `invoke` for orchestrator-internal tasks (memory, summarization) |
| `src/services/ProjectRoot.ts` | Project root path service |
| `src/services/CharacterFs.ts` | Character file system operations |
| `src/services/Docker.ts` | Docker container management |
| `src/services/OAuthToken.ts` | OAuth token resolution for container injection |
| `src/logging/log-writer.ts` | CharacterLog service (JSONL append) |
| `src/logging/console-renderer.ts` | Type-tagged + narrative console output |
| `src/logging/stream-normalizer.ts` | Normalize stream-json output from Claude |

### Infrastructure

| File | Role |
|------|------|
| `scripts/run-step.sh` | In-container: cd to player dir, exec claude -p |
| `.devcontainer/Dockerfile` | Container image: node20, claude-code, firewall |
| `.devcontainer/init-firewall.sh` | iptables whitelist for allowed domains |
