# Agent Harness

The harness runs autonomous character-driven sessions inside shared Docker containers, using Claude Code as the agent runtime. An orchestrator on the host manages the session lifecycle: connect to a domain, spawn a persistent channel session, push state updates as events, and capture all output.

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
                 +-- runChannelSession()               packages/core/src/core/orchestrator/channel-session.ts
```

### Channel Session Model

The primary execution engine is `runChannelSession()`. It spawns a persistent `claude --channels` process inside the Docker container and pushes events to it over the session lifetime.

**Lifecycle:**

1. **Spawn** -- The orchestrator calls `runSession()`, which writes a `.mcp.json` config, builds `claude --channels` CLI args, and starts the process via `docker exec`. The session runs continuously inside the container.

2. **Task injection** -- After a 2-second stabilization delay, the orchestrator pushes an initial task event via HTTP POST to the channel server. This task contains the full situation briefing, agent identity, and instructions.

3. **Tick loop** -- Every 30 seconds, the orchestrator:
   - Drains the event queue (non-blocking poll)
   - Processes events through `EventProcessor` to update state
   - Classifies the situation via `SituationClassifier`
   - Evaluates interrupt rules via `InterruptRegistry`
   - If critical interrupts fire: kills the session, returns `Interrupted`
   - If session completed naturally: returns `Completed`
   - Otherwise: runs the OODA skill chain (observe → orient → decide → evaluate) to classify events, assess the situation, produce plans, and push structured directives to the session. Falls back to `PromptBuilder.channelEvent()` if the OODA chain fails.

4. **Termination** -- The session ends when:
   - The agent completes its work and exits naturally
   - A critical interrupt fires (CI failure, combat, hull critical)
   - The session timeout expires (default: 1 hour)

**Key constants:**

| Constant | Value | Purpose |
|----------|-------|---------|
| `TICK_INTERVAL_MS` | 30,000 | How often the orchestrator pushes state updates |
| `DEFAULT_SESSION_TIMEOUT_MS` | 3,600,000 | Maximum session duration (1 hour) |
| `POST_SPAWN_DELAY_MS` | 2,000 | Wait after spawn before pushing the first task |

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
  +--[critical]--> Kill session, return Interrupted
  +--[soft]------> Include in next channel event
  |
  v
ORCHESTRATOR: push channel event to running session
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
| **PromptBuilder** | `PromptBuilderTag` | Assembles session prompts: `systemPrompt`; `taskPrompt` and `channelEvent` are deprecated fallbacks (OODA chain now produces session content) |
| **SkillRegistry** | `SkillRegistryTag` | Domain skill catalog and deterministic step-completion checks |

### Phase System

Sessions progress through a sequence of named phases. Each phase returns a `PhaseResult`: `Continue` (with next phase name), `Restart`, or `Shutdown`. The phase runner drives the sequence.

`PhaseContext` carries the character config, container ID, container env, an optional `ConnectionState` (event queue + initial state), optional `phaseData` for inter-phase threading, and the `DomainBundle`.

#### SpaceMolt Phase Lifecycle

```
startup --> active (channel session) --> social (dinner) --> reflection (dream) --> active
```

- **startup** -- Read credentials, connect via WebSocket, compress diary if over threshold
- **active** -- `runChannelSession` with domain bundle. On interrupt: restart active. On completion: proceed to social
- **social** -- Run `dinner.execute()` for social reflection
- **reflection** -- Run `runReflection` to compress diary if over 200 lines. Loop back to active

#### GitHub Phase Lifecycle

```
startup --> active (channel session) --> break (90 min) --> reflection (dream) --> active
                 \                              ^
                  \---> (critical interrupt) ---/
```

- **startup** -- Read `github.json`, validate token, clone repos, create worktrees, start GraphQL polling
- **active** -- `runChannelSession` with domain bundle. On interrupt: restart active. On completion: proceed to break
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
| **Session Model** | Persistent channel session | Persistent channel session |
| **Interrupts** | 9 rules (combat, hull, fuel, cargo, etc.) | 5 rules (CI, review, triage, etc.) |
| **Skills** | Stub (LLM evaluates all steps) | File-based loader from `.claude/skills/` |

## Session Execution Detail

```
  Orchestrator          Docker Container          Channel Server
  (host)                (roci-<domain>)           (localhost:port)
  |                     |                         |
  | docker exec         |                         |
  | claude --channels   |                         |
  |-------------------->|                         |
  |                     | spawns session          |
  |                     |------------------------>|
  |                     |                         |
  | POST /event (task)  |                         |
  |-------------------------------------------->  |
  |                     |  <-- receives task       |
  |                     |                         |
  | [every 30s]         |                         |
  | POST /event (tick)  |                         |
  |-------------------------------------------->  |
  |                     |  <-- receives state      |
  |                     |      update event        |
  |                     |                         |
  |<====================| stream-json stdout       |
  |  parse, log, route  |                         |
  |                     |                         |
  | [on completion]     |                         |
  |<====================| session-result.json      |
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
| `src/core/orchestrator/channel-session.ts` | Channel session event loop -- the primary execution engine |
| `src/core/limbic/hypothalamus/session-runner.ts` | Spawns `claude --channels` in container, returns `SessionHandle` |
| `src/core/limbic/hypothalamus/runtime.ts` | Runtime binary selection (claude vs opencode) and CLI arg building |
| `src/core/limbic/thalamus/event-processor.ts` | EventProcessor, EventResult, EventCategory |
| `src/core/limbic/thalamus/situation-classifier.ts` | SituationClassifier, SituationSummary |
| `src/core/limbic/amygdala/interrupt.ts` | InterruptRule, InterruptRegistry, createInterruptRegistry() |
| `src/core/limbic/hippocampus/dream.ts` | Dream compression (diary + secrets) |
| `src/core/phase.ts` | Phase, PhaseContext, PhaseResult, PhaseRegistry |
| `src/core/phase-runner.ts` | Runs phases in sequence, handles Continue/Restart/Shutdown |
| `src/core/domain-bundle.ts` | DomainBundle (6 service layers) + DomainConfig |
| `src/core/prompt-builder.ts` | PromptBuilder interface (systemPrompt; taskPrompt/channelEvent deprecated) |
| `src/core/ooda-runner.ts` | OODA skill invocation module (observe, orient, decide, evaluate via runTurn) |
| `src/core/state-renderer.ts` | StateRenderer interface |
| `src/core/skill.ts` | Skill + SkillRegistry interface |
| `src/core/model-config.ts` | Tier-based model resolution |
| `src/skills/` | Operating skill templates (observe, orient, decide, evaluate) |

### GitHub domain -- `packages/domain-github/` (@roci/domain-github)

| File | Role |
|------|------|
| `src/phases.ts` | Phase registry: startup, active (runChannelSession), break, reflection |
| `src/index.ts` | Domain bundle assembly and file-based skill loading |
| `src/types.ts` | All domain types: state, events, situations, config |
| `src/github-client.ts` | GraphQL polling client (1 query per repo per poll) |
| `src/prompt-builder.ts` | Prompt generation: system, task, channel event |
| `src/interrupts.ts` | Declarative interrupt rules (CI, review, triage, stale PRs) |
| `src/situation-classifier.ts` | Per-repo classification and aggregate rollup |
| `src/renderer.ts` | State snapshots, rich diffs, status bar |
| `src/session-system-prompt.md` | System prompt for the persistent session |
| `src/procedures/` | Procedure templates (select, triage, feature, review) |

### SpaceMolt domain -- `packages/domain-spacemolt/` (@roci/domain-spacemolt)

| File | Role |
|------|------|
| `src/phases.ts` | Phase registry: startup, active (runChannelSession), social, reflection |
| `src/index.ts` | Domain bundle assembly and stub skill registry |
| `src/types.ts` | All domain types: game state, player, ship, system, POI, situation |
| `src/game-socket-impl.ts` | WebSocket connection, login flow, event dispatching |
| `src/event-processor.ts` | Maps WebSocket events to state operations |
| `src/situation-classifier.ts` | Situation classification (combat, transit, docked, in-space) |
| `src/interrupts.ts` | 9 interrupt rules across 4 priority levels |
| `src/prompt-builder.ts` | Template-based prompt generation |
| `src/session-system-prompt.md` | System prompt for the persistent session |
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
