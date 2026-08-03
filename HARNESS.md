# Agent Harness

The harness runs autonomous character-driven sessions inside shared Docker containers. An orchestrator on the host manages the lifecycle: connect to a domain, run the per-character **`brain/stem` tick engine** (`runActivation` — an activation/reticular-activating conductor that paces, polls, and dispatches; see [docs/CORTEX.md](docs/CORTEX.md)), feed state updates in as events on an Effect queue, and capture all output. The engine appraises events across three local model tiers (reflexive → integrative → deliberative), plans and executes work as tool-using OpenCode sessions inside the container, and steers or interrupts that work as the world changes. The whole cognitive stack lives under `packages/core/src/brain/` — see [packages/core/src/brain/BRAIN.md](packages/core/src/brain/BRAIN.md) for the top-level map.

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
                 +-- runActivation()                     packages/core/src/brain/stem/loop.ts
                     (active phase; see domain phases.ts)
```

### The `brain/stem` Tick Engine

The execution engine is `runActivation()` (`packages/core/src/brain/stem/loop.ts`),
called once per character from the domain's `active` phase
(`domain-spacemolt/src/phases.ts`, `domain-github/src/phases.ts`). It is an
infinite tick loop; world events arrive on an Effect `Queue` (not pushed into a
running CLI over HTTP), and cognition is split across three local model tiers —
**hindbrain** (2B per-event appraisal), **forebrain** (9B orient), and
**conscious** (31B decide/evaluate plus the tool-using OpenCode executor).

Each tick (default 30s): **drain** queued events into state → **classify** the
situation and check critical interrupts (a critical exits the loop) → **poll** any
in-flight conscious turn → **hindbrain-appraise** each state-changing event into an
escalation signal → **forebrain** orient (idle: orient→decide→plan; in-session:
steer/reorient/interrupt) → **execute** the active plan step as a conscious turn,
or **evaluate** it when it signals done or its tick budget elapses → **sleep**.

Real loop constants (`brain/stem/loop.ts`): `DEFAULT_TICK_MS = 30_000`,
`DEFAULT_ORIENT_INTERVAL = 5`, `DEFAULT_WORKER_TIMEOUT_MS = 60 * 60 * 1000` (1h
per-turn budget), `DEFAULT_STEER_CADENCE_TICKS = 3`. The tick interval is
overridable via `tickIntervalMs` / `--tick-interval`.

See [docs/CORTEX.md](docs/CORTEX.md) for the full tick anatomy, the three tiers,
plan/step/completion model, steering, parse tolerance, and the conscious executor
(including the `frontier` delegation tool).

The whole cognitive stack lives under `packages/core/src/brain/`, organized as a
conductor plus two depth-layered layers and a shared transport seam
(see [BRAIN.md](packages/core/src/brain/BRAIN.md)):

```
packages/core/src/brain/stem/       runActivation tick engine, escalation-state reducer, JSON parse-tolerance
packages/core/src/brain/stem/transport/  SHARED docker-exec turn plumbing (both layers import it)
packages/core/src/brain/limbic/     PRE-CONSCIOUS layer (reflexive + integrative)
packages/core/src/brain/cortex/     CONSCIOUS layer (deliberative): conscious/ executor + frontier CLI
packages/core/src/model/            Neutral model->binary dispatch, tier handles, ModelClient
```

### Limbic System (the pre-conscious layer)

Domain-agnostic subsystems live under `packages/core/src/brain/limbic/`, organized by analogy to limbic brain regions — the reflexive and integrative depth tiers, everything up to and including **orient**. See [LIMBIC.md](packages/core/src/brain/limbic/LIMBIC.md) for full documentation.

```
packages/core/src/brain/limbic/
 +-- thalamus/         Sensory relay: event processing, situation classification (integrative)
 +-- amygdala/         Threat detection: interrupt safety-rail (reflexive)
 +-- hypothalamus/     Homeostatic regulation: tempo, cadence, innate drives (reflexive)
 +-- hippocampus/      Episodic/narrative memory: dream consolidate+cull, long-term vector store
 +-- wm/               Working (procedural/intent) memory: plan/todo state machine
```

**Data flow:**

```
Domain Events (WebSocket, GraphQL poll, etc.) --> Effect Queue
  |
  v
THALAMUS: EventProcessor.processEvent(event, state) --> EventResult
  |  apply stateUpdate (state-changing) or fast-path (inert)
  v
THALAMUS: SituationClassifier.summarize(state) --> SituationSummary
  |
  v
AMYGDALA: InterruptRegistry.criticals(state, situation)
  +--[critical]--> interrupt the in-flight turn, return Interrupted (exit loop)
  |
  v
HINDBRAIN: runHindbrain per state-changing event --> ObserveResult
  |  appraiseTick --> HindbrainEscalation (none/accumulate/steer/reorient/interrupt)
  v
FOREBRAIN: runForebrain orient --> CONSCIOUS: runConsciousDecide / step turn
  |  (idle: orient->decide->plan; in-session: steer / reorient / interrupt)
  v
HIPPOCAMPUS: dream.execute() (in reflection phase, when diary exceeds threshold)
```

### Operating Skills

Operating skills define how agents think at each stage of the OODA loop: observe, orient, decide, evaluate. They are markdown templates with YAML frontmatter, split across the layer boundary: the pre-conscious prompts (`observe.md`, `orient.md`) live in `packages/core/src/brain/limbic/prompts/`; the deliberative prompts (`decide.md`, `evaluate.md`, `diary.md`) live in `packages/core/src/brain/cortex/conscious/prompts/`. The loader machinery (`loadSkillSync`) remains in `packages/core/src/skills/`. See [docs/OPERATING_SKILLS.md](docs/OPERATING_SKILLS.md) for full documentation.

### Domain Services

All domain knowledge is injected via 5 Effect service layers, provided as a `DomainBundle`. See [docs/DOMAIN_GUIDE.md](docs/DOMAIN_GUIDE.md) for full documentation.

| Service | Tag | Role |
|---------|-----|------|
| **EventProcessor** | `EventProcessorTag` | Maps raw domain events to `EventResult` with `EventCategory` discriminated union |
| **SituationClassifier** | `SituationClassifierTag` | `summarize(state)` -- structured `SituationSummary` with headline, sections, metrics |
| **InterruptRegistry** | `InterruptRegistryTag` | Declarative interrupt rules with priority, condition, message, `suppressWhenTaskIs` |
| **StateRenderer** | `StateRendererTag` | Rich snapshots, diffs, console state bar |
| **PromptBuilder** | `PromptBuilderTag` | Assembles the conscious agent's `systemPrompt(mode, task)` (`brain/stem/loop.ts`) |

### Phase System

Sessions progress through a sequence of named phases. Each phase returns a `PhaseResult`: `Continue` (with next phase name), `Restart`, or `Shutdown`. The phase runner drives the sequence.

`PhaseContext` carries the character config, container ID, container env, an optional `ConnectionState` (event queue + initial state), optional `phaseData` for inter-phase threading, and the `DomainBundle`.

#### SpaceMolt Phase Lifecycle

```
startup --> active (brain/stem) --> social --> reflection (dream) --> active
```

- **startup** -- Read `.spacemolt-session.json`, connect via `@spacemolt/lib`'s `Account`, compress diary if over threshold
- **active** -- `runActivation` with domain bundle. On interrupt: restart active. On completion: proceed to social
- **social** -- A quiet wind-down boundary at the end of a session (the old `dinner.execute()` diary rewrite is now the domain-agnostic consolidate turn inside `runReflection`)
- **reflection** -- Run `runReflection`, whose unified `dream.execute()` consolidates then culls the diary/secrets toward the `DIARY_TARGET_LINES` target (150 lines, `dream.ts:16`), all on the local model. Loop back to active

#### GitHub Phase Lifecycle

```
startup --> active (brain/stem) --> break (90 min) --> reflection (dream) --> active
                 \                         ^
                  \---> (critical interrupt) ---/
```

- **startup** -- Read `github.json`, validate token, clone repos, create worktrees, start GraphQL polling
- **active** -- `runActivation` with domain bundle. On interrupt: restart active. On completion: proceed to break
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

Two model systems coexist. The `brain/stem` engine uses its own MLX tier topology —
`hindbrain`/`forebrain`/`conscious`, configured in `model/handles.ts` (see
[docs/CORTEX.md](docs/CORTEX.md) §2). The older `fast`/`smart`/`reasoning` tier
system with per-role overrides still backs host-side helpers and the `frontier`
worker model. See [docs/MODEL_CONFIG.md](docs/MODEL_CONFIG.md) for details.

## Domain Comparison

| | SpaceMolt | GitHub |
|---|-----------|--------|
| **Phases** | startup, active, social, reflection | startup, active, break, reflection |
| **Event Source** | WebSocket (real-time game events) | GraphQL polling (30s interval) |
| **Execution Engine** | `brain/stem` (`runActivation`) | `brain/stem` (`runActivation`) |
| **Interrupts** | 10 rules (combat, hull, fuel, cargo, etc.) | 5 rules (CI, review, triage, etc.) |

## Execution Detail

There is no channel server and no HTTP event POST. Events arrive on an in-process
Effect `Queue`; the `brain/stem` engine drains it each tick. Plan-step work runs as a
tool-using OpenCode session that the loop forks (turn 1) and resumes (later turns)
via `docker exec`.

```
  brain/stem engine (host)        Docker Container (roci-<domain>)
  |                               |
  | drain Effect Queue            |
  | hindbrain/forebrain/conscious |  (mlx tiers on :8081/:8082/:8083)
  |                               |
  | ConsciousThought.turn() ----> | docker exec opencode (conscious agent)
  |  (fork turn 1, resume later)  |   runs tools, streams output
  |<----------------------------- | turn result (output + sessionId)
  |                               |
  | evaluate / steer / advance    |
  | [critical] interrupt + exit   |
```

See [docs/CORTEX.md](docs/CORTEX.md) §7 (the conscious executor) and §3 (tick
anatomy) for the details.

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

Add to the rules array in the domain's `reflexes.ts`:

```typescript
{ name: "fuel_emergency", priority: "critical",
  condition: (s, sit) => s.ship.fuel / s.ship.max_fuel < LOW_FUEL_THRESHOLD && sit.type !== SituationType.Docked,
  message: (s) => `Fuel critical (${s.ship.fuel}). Dock immediately.`,
  suppressWhenTaskIs: "refuel" }
```

For SpaceMolt this is deliberately a one-rule registry. Most conditions should be deterministic appraisers, not interrupt rules -- see LIMBIC.md.

`createInterruptRegistry(rules)` builds an `InterruptRegistry` that handles rule walking, suppression, sorting, and partitioning. Only `criticals()` is wired to anything -- `softAlerts()` has zero production callers, so a non-critical rule is a log line in the `interrupt_eval` audit note. A condition that wants to steer the running session belongs in `EventProcessor.deterministicAppraisers` instead. See the [LIMBIC.md](packages/core/src/brain/limbic/LIMBIC.md) amygdala section for details.

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
| `src/brain/stem/loop.ts` | `runActivation` -- the `brain/stem` tick engine, the primary execution engine |
| `src/brain/limbic/tiers-limbic.ts` | Pre-conscious tier runners: `runHindbrain`/`runForebrain` |
| `src/brain/cortex/conscious/tiers-conscious.ts` | Conscious tier runners: `runConsciousDecide`/`runConsciousEvaluate`/`runDiaryTurn` |
| `src/brain/stem/state.ts` | Loop state, the escalation ladder (`appraise`/`appraiseTick`/`HindbrainEscalation`), plan/step/completion helpers |
| `src/brain/stem/parse.ts` | Tolerant JSON extraction (`extractJson`/`tryParseJson`/`parseOr`) for mlx tier output |
| `src/brain/cortex/conscious/conscious-thought.ts` | `ConsciousThought` service: provisions and runs the tool-using OpenCode executor |
| `src/brain/cortex/conscious/frontier-cli.ts` | The `frontier` delegation tool (detached reasoning-model worker) |
| `src/brain/limbic/hippocampus/memory/memory-cli.ts`, `memory/longterm-store.ts` | Long-term memory (hippocampus-owned): host-side provisioning + exec seam for the `memory` CLI, which ships as a bundle from `@roci/player-tools` (sqlite-vec store) |
| `src/model/handles.ts` | Cortex tier handles + `DEFAULT_CORTEX_MODELS` (hindbrain/forebrain/conscious) |
| `src/model/client.ts` | `ModelClient` -- OpenAI-compatible completion client for the mlx tiers |
| `src/core/orchestrator/index.ts` | Orchestrator barrel (re-exports `runReflection`/`runBreak`, lifecycle, planning) |
| `src/core/orchestrator/planned-action.ts` | `runReflection` (dream/cull + memory promotion) and `runBreak` |
| `src/core/orchestrator/lifecycle.ts` | `PlanContext`, `LifecycleHooks` for the planned-action cadence |
| `src/brain/stem/transport/process-runner.ts` | `runTurn`/`runOpenCodeSessionTurn` -- shared docker-exec transport for conscious + memory turns |
| `src/model/runtime.ts` | Runtime binary selection (claude vs opencode) and CLI arg building |
| `src/brain/limbic/thalamus/event-processor.ts` | EventProcessor, EventResult, EventCategory |
| `src/brain/limbic/thalamus/situation-classifier.ts` | SituationClassifier, SituationSummary |
| `src/brain/limbic/amygdala/interrupt.ts` | InterruptRule, InterruptRegistry, createInterruptRegistry() |
| `src/brain/limbic/hippocampus/dream.ts` | Dream compression / diary cull (`DIARY_TARGET_LINES = 150`) |
| `src/brain/limbic/wm/wm-store.ts` | Working (procedural/intent) memory: plan/todo state machine |
| `src/core/phase.ts` | Phase, PhaseContext, PhaseResult, PhaseRegistry |
| `src/core/phase-runner.ts` | Runs phases in sequence, handles Continue/Restart/Shutdown |
| `src/core/domain-bundle.ts` | DomainBundle (5 service layers) + DomainConfig |
| `src/core/prompt-builder.ts` | PromptBuilder interface (`systemPrompt(mode, task)`) |
| `src/core/state-renderer.ts` | StateRenderer interface (`richSnapshot`, `stateDiff`, `formatStateBar`) |
| `src/brain/limbic/hypothalamus/drives.ts` | Innate drives (`TEMPLATE_DRIVES`, `CORE_DRIVE_NAMES`, `renderDriveLines`) |
| `src/core/model-config.ts` | Legacy tier-based model resolution (`fast`/`smart`/`reasoning`); see also `src/services/model-tier-spec.ts` |
| `src/brain/limbic/prompts/`, `src/brain/cortex/conscious/prompts/` | Operating skill templates: observe/orient (pre-conscious) + decide/evaluate/diary (conscious) |
| `src/skills/loader.ts` | Skill-template loader machinery (`loadSkillSync`) |

### GitHub domain -- `packages/domain-github/` (@roci/domain-github)

| File | Role |
|------|------|
| `src/phases.ts` | Phase registry: startup, active (runActivation), break, reflection |
| `src/index.ts` | Domain bundle assembly and file-based skill loading |
| `src/types.ts` | All domain types: state, events, situations, config |
| `src/github-client.ts` | GraphQL polling client (1 query per repo per poll) |
| `src/prompt-builder.ts` | Prompt generation: system, task, channel event |
| `src/interrupts.ts` | Declarative interrupt rules (CI, review, triage, stale PRs) |
| `src/situation-classifier.ts` | Per-repo classification and aggregate rollup |
| `src/renderer.ts` | State snapshots, rich diffs, status bar |
| `src/session-system-prompt.md` | Domain system prompt template |
| `src/procedures/` | Procedure templates (select, triage, feature, review) |

### SpaceMolt domain -- `packages/domain-spacemolt/` (@roci/domain-spacemolt)

| File | Role |
|------|------|
| `src/phases.ts` | Phase registry: startup, active (runActivation), social, reflection |
| `src/index.ts` | Domain bundle assembly and stub skill registry |
| `src/types.ts` | All domain types: game state, player, ship, system, POI, situation |
| `src/game-events.ts` | Frame vocabulary over `@spacemolt/lib`'s generated notification catalog, plus `schemaGapNote` |
| `src/lib-state.ts` | Pure translator: the library's 8-section StateCache → the domain's `GameState` |
| `src/account-socket.ts` | `Account` adapter -- connect, auth, subscribe, the three event sinks, close |
| `src/event-processor.ts` | Maps push frames + `state_sync`/`connection_state` to state operations |
| `src/situation-classifier.ts` | Situation classification (combat, docked, in-space) |
| `src/reflexes.ts` | The two reflexes: combat onset (deterministic appraiser) and your own death (the one interrupt rule) |
| `src/prompt-builder.ts` | Template-based prompt generation |

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
| `.devcontainer/Dockerfile` | Container image: node20, claude-code, firewall |
| `.devcontainer/init-firewall.sh` | iptables whitelist for allowed domains |
