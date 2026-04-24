# Domain Guide

How to build a new domain for the Roci orchestrator. New domains should be created as workspace packages under `packages/domain-<name>/` (e.g. `packages/domain-mydomain/`), with the package name `@roci/domain-<name>`. Domain code imports from `@roci/core` instead of relative paths.

## What is a Domain?

The orchestrator is a generic engine for running autonomous character-driven sessions. It spawns persistent channel sessions inside Docker containers, pushes state updates as events, and monitors for interrupts. None of this logic knows about any specific game or environment.

A **domain** plugs into this engine by implementing 6 service interfaces (plus a phase registry and config object). The core never imports domain code -- services are injected via Effect tags at startup. SpaceMolt and GitHub are the two reference implementations.

## The 6 Services at a Glance

| # | Interface | Tag | Purpose | Difficulty |
|---|-----------|-----|---------|------------|
| 1 | `EventProcessor` | `EventProcessorTag` | Translate raw events to `EventResult` with `EventCategory` | Medium |
| 2 | `SituationClassifier` | `SituationClassifierTag` | Derive `SituationSummary` (headline, sections, metrics) from state | Medium |
| 3 | `StateRenderer` | `StateRendererTag` | State to human-readable text (snapshots, diffs, console bar) | Medium |
| 4 | `InterruptRegistry` | `InterruptRegistryTag` | Declarative rules that trigger session interruption | Easy |
| 5 | `PromptBuilder` | `PromptBuilderTag` | Assemble session prompts (system, task, channel events) | Hard |
| 6 | `SkillRegistry` | `SkillRegistryTag` | Domain skill catalog and deterministic step-completion checks | Easy (stub OK) |

Additionally:
- **`PhaseRegistry`** -- defines the session lifecycle (connect, play, reflect, repeat)
- **`DomainConfig`** -- bundles everything together for the orchestrator

## Step-by-Step: Building a Domain

### 1. Define Your Types (`types.ts`)

Create types for your domain's state, situation, and events. The core uses opaque `DomainState`, `DomainSituation`, and `DomainEvent` type aliases (all `unknown`), so your implementations cast internally.

```ts
// packages/domain-mydomain/src/types.ts

export interface MyState {
  projectName: string
  openIssues: Issue[]
  lastDeploy: DeployInfo | null
  tick: number
  timestamp: number
}

export interface MySituation {
  type: MySituationType
  flags: {
    hasCriticalBug: boolean
    deployPending: boolean
  }
}

export enum MySituationType {
  Idle = "idle",
  Deploying = "deploying",
  Incident = "incident",
}

export type MyEvent =
  | { type: "state_update"; payload: MyState }
  | { type: "webhook"; payload: WebhookPayload }
  | { type: "tick"; payload: { tick: number } }
```

### 2. `EventProcessor` -- Translate Events

Maps raw domain events into `EventResult` objects:

```ts
import { Layer } from "effect"
import { EventProcessorTag, type EventResult } from "@roci/core/core/limbic/thalamus/event-processor.js"

const myEventProcessor = {
  processEvent(event: unknown, _currentState: unknown): EventResult {
    const e = event as MyEvent
    switch (e.type) {
      case "state_update":
        return {
          category: { _tag: "StateChange" },
          stateUpdate: () => e.payload,
        }
      case "tick":
        return {
          category: { _tag: "Heartbeat", tick: e.payload.tick },
        }
      default:
        return {}
    }
  },
}

export const MyEventProcessorLive = Layer.succeed(EventProcessorTag, myEventProcessor)
```

`EventResult` uses a discriminated union `EventCategory`:

```ts
type EventCategory =
  | { _tag: "Heartbeat"; tick: number }
  | { _tag: "StateChange" }
  | { _tag: "LifecycleReset"; reason: string }

interface EventResult {
  category?: EventCategory
  stateUpdate?: (prev) => next
  context?: DomainContext       // e.g. chatMessages
  log?: () => void
  alert?: string                // immediate push to channel session
}
```

### 3. `SituationClassifier` -- `summarize()`

Derives a structured `SituationSummary` from raw state:

```ts
import { Layer } from "effect"
import { SituationClassifierTag } from "@roci/core/core/limbic/thalamus/situation-classifier.js"

const myClassifier = {
  summarize(state: unknown): SituationSummary {
    const s = state as MyState
    return {
      situation: classifySituation(s),
      headline: `${s.projectName}: ${s.openIssues.length} open issues`,
      sections: [
        { id: "issues", heading: "Open Issues",
          body: s.openIssues.map(i => `- [${i.severity}] ${i.title}`).join("\n") },
      ],
      metrics: {
        issueCount: s.openIssues.length,
        deployPending: s.lastDeploy?.status === "pending" ?? false,
      },
    }
  },
}

export const MySituationClassifierLive = Layer.succeed(SituationClassifierTag, myClassifier)
```

The `SituationSummary` shape:
- **`situation`** -- your domain-specific situation object (opaque to the core)
- **`headline`** -- one-line summary used in prompts and logging
- **`sections`** -- structured content blocks (each has `id`, `heading`, `body`)
- **`metrics`** -- key/value pairs passed to `StateRenderer.logStateBar()`

### 4. `StateRenderer` -- Snapshots, Diffs, Console Bar

Renders state into human-readable forms for diff tracking and logging:

```ts
import { Layer } from "effect"
import { StateRendererTag } from "@roci/core/core/state-renderer.js"

const myRenderer = {
  snapshot(state: unknown): Record<string, unknown> {
    const s = state as MyState
    return { project: s.projectName, issues: s.openIssues.length }
  },
  richSnapshot(state: unknown): Record<string, unknown> {
    return { ...(state as MyState) }
  },
  stateDiff(before: Record<string, unknown> | null, after: Record<string, unknown>): string {
    if (!before) return "(initial state)"
    return `Issues: ${before.issues} → ${(after as any).issues}`
  },
  logStateBar(name: string, metrics: Record<string, string | number | boolean>): void {
    console.log(`[${name}] issues=${metrics.issueCount}`)
  },
}

export const MyStateRendererLive = Layer.succeed(StateRendererTag, myRenderer)
```

### 5. `InterruptRegistry` -- Rules + Factory

Declarative rules that detect conditions warranting session interruption:

```ts
import { Layer } from "effect"
import { InterruptRegistryTag, createInterruptRegistry } from "@roci/core/core/limbic/amygdala/interrupt.js"

const rules: ReadonlyArray<InterruptRule> = [
  {
    name: "critical_bug",
    priority: "critical",
    condition: (state) => (state as MyState).openIssues.some(i => i.severity === "critical"),
    message: () => "Critical bug detected — investigate immediately.",
    suppressWhenTaskIs: "investigate",
  },
  {
    name: "deploy_stale",
    priority: "medium",
    condition: (state) => {
      const s = state as MyState
      return s.lastDeploy != null && Date.now() - s.lastDeploy.timestamp > 86400000
    },
    message: () => "No deploy in 24 hours.",
  },
]

export const MyInterruptRegistryLive = Layer.succeed(
  InterruptRegistryTag,
  createInterruptRegistry(rules),
)
```

The factory handles: iterating rules, checking conditions, building `Alert` objects, respecting `suppressWhenTaskIs`, and sorting by priority.

### 6. `PromptBuilder` -- Session Prompts

The PromptBuilder has three methods that control what the agent sees:

```ts
interface PromptBuilder {
  systemPrompt(mode: BrainMode, task: string): string
  taskPrompt(ctx: TaskPromptContext): string
  channelEvent(ctx: ChannelEventContext): string
}
```

**`systemPrompt(mode, task)`** -- The system prompt for the persistent session. Defines the agent's capabilities and constraints. Can vary by mode (e.g., read-only vs. full-access) and task (e.g., diary-only).

**`taskPrompt(ctx)`** -- The initial task injected when a new session starts. Should contain the full situation briefing, agent identity, and work instructions. Context includes:

```ts
interface TaskPromptContext {
  state: DomainState
  summary: SituationSummary
  diary: string
  background: string
  values: string
}
```

**`channelEvent(ctx)`** -- State update events pushed every tick (30 seconds). Should be concise -- the agent receives these as ongoing context during its work. Context includes:

```ts
interface ChannelEventContext {
  summary: SituationSummary
  stateDiff?: string
  softAlerts?: Alert[]
  tickNumber: number
}
```

See the GitHub implementation (`packages/domain-github/src/prompt-builder.ts`) for a full reference.

### 7. `SkillRegistry` -- Stub or Implement

A stub is valid for getting started:

```ts
import { Layer } from "effect"
import { SkillRegistryTag } from "@roci/core/core/skill.js"

export const StubSkillRegistryLive = Layer.succeed(SkillRegistryTag, {
  skills: [],
  getSkill: () => undefined,
  taskList: () => "",
  isStepComplete: () => ({
    complete: false,
    reason: "No skill registry configured",
    matchedCondition: null,
    relevantState: {},
  }),
})
```

For file-based skills, see the GitHub domain's `index.ts` which loads `.md` files with YAML frontmatter from `.claude/skills/` subdirectories.

### 8. `PhaseRegistry` -- Session Lifecycle

Phases are the top-level session structure. A minimal registry needs startup (connects and returns a `ConnectionState`) and active (runs `runChannelSession`).

```ts
import { Effect, Queue } from "effect"
import { runChannelSession } from "@roci/core/core/orchestrator/channel-session.js"

const activePhase = {
  name: "active",
  run: (context: PhaseContext) =>
    Effect.gen(function* () {
      if (!context.connection || !context.domainBundle) {
        return { _tag: "Shutdown" } as PhaseResult
      }

      const result = yield* runChannelSession({
        char: context.char,
        containerId: context.containerId,
        containerEnv: context.containerEnv,
        events: context.connection.events as Queue.Queue<unknown>,
        initialState: context.connection.initialState,
        sessionModel: "sonnet",
      }).pipe(Effect.provide(context.domainBundle))

      const conn = { ...context.connection, initialState: result.finalState }
      if (result._tag === "Interrupted") {
        return { _tag: "Continue", next: "active", connection: conn } as PhaseResult
      }
      return { _tag: "Continue", next: "break", connection: conn } as PhaseResult
    }),
}
```

The key pattern: **`Effect.provide(context.domainBundle)`** injects your 6 service layers into the engine.

Domains typically add `break` (polls for critical interrupts during rest) and `reflection` (dream compression) phases alongside `active`. The core provides `runBreak` and `runReflection` as reusable building blocks.

### 9. `DomainConfig` -- Assemble Everything

```ts
import { Layer } from "effect"
import type { DomainConfig, DomainBundle } from "@roci/core/core/domain-bundle.js"

export const myDomainBundle: DomainBundle = Layer.mergeAll(
  MyEventProcessorLive,
  MySituationClassifierLive,
  MyStateRendererLive,
  MyInterruptRegistryLive,
  MyPromptBuilderLive,
  StubSkillRegistryLive,
)

export const myDomainConfig = (projectRoot: string): DomainConfig => ({
  bundle: myDomainBundle,
  phaseRegistry: myPhaseRegistry,
  containerMounts: [
    { host: `${projectRoot}/players`, container: "/work/players" },
  ],
  imageName: "my-domain-player",
})
```

Register in `apps/roci/src/domains/registry.ts`:

```ts
export const DOMAIN_REGISTRY: Record<string, DomainConfigFactory> = {
  spacemolt: spaceMoltDomainConfig,
  github: gitHubDomainConfig,
  mydomain: myDomainConfig,
}
```

## Implicit Contracts

Things the type system doesn't enforce but your domain must respect:

### `SituationSummary` Structure

`summarize()` returns all state context the agent needs. The `headline` is a short summary. The `sections` array provides structured detail for prompts. The `metrics` record feeds `logStateBar()`. Design sections so the agent gets enough context to make decisions without raw state.

### Alerts Come from `InterruptRegistry`, Not `summarize()`

The `InterruptRegistry` owns all alert evaluation. `summarize()` classifies state. The engine calls `interruptRegistry.evaluate()` separately after each state classification.

### `tickIntervalSec`

This is your heartbeat interval in seconds. Even if your domain doesn't have a traditional "tick", set it to your desired polling interval. It controls timeout calculations.

## Container Architecture

Each domain runs in its own Docker container named `roci-<domain>`. Characters within a domain share a container.

### Canonical Mount Paths

| Container Path | Purpose | Required? |
|---|---|---|
| `/work/players` | Character directories | Yes |
| `/work/.claude` | Claude config | Yes (readonly) |
| `/opt/scripts` | Orchestrator scripts | Yes (readonly) |
| Domain-specific | Up to each domain's `containerMounts` | No |

### `DomainConfig` Fields for Docker

| Field | Default | Purpose |
|---|---|---|
| `imageName` | -- | Docker image tag |
| `dockerfilePath` | `.devcontainer/Dockerfile` | Path to Dockerfile |
| `dockerContext` | `.devcontainer` | Docker build context |
| `containerMounts` | -- | Volume mounts |
| `containerSetup` | -- | Post-start hook (e.g. creating symlinks) |
| `containerAddDirs` | `[]` | Paths for `--add-dir` flags |
| `serviceLayer` | -- | Domain-specific Effect service layer |

## Reference: Implementation Maps

### SpaceMolt

| Service | File |
|---------|------|
| `EventProcessor` | `packages/domain-spacemolt/src/event-processor.ts` |
| `SituationClassifier` | `packages/domain-spacemolt/src/situation.ts` |
| `StateRenderer` | `packages/domain-spacemolt/src/renderer.ts` |
| `InterruptRegistry` | `packages/domain-spacemolt/src/interrupts.ts` |
| `PromptBuilder` | `packages/domain-spacemolt/src/prompt-builder.ts` |
| `SkillRegistry` | Stub in `packages/domain-spacemolt/src/index.ts` |
| `PhaseRegistry` | `packages/domain-spacemolt/src/phases.ts` |
| Event source | `packages/domain-spacemolt/src/game-socket-impl.ts` (WebSocket) |

### GitHub

| Service | File |
|---------|------|
| `EventProcessor` | `packages/domain-github/src/event-processor.ts` |
| `SituationClassifier` | `packages/domain-github/src/situation-classifier.ts` |
| `StateRenderer` | `packages/domain-github/src/renderer.ts` |
| `InterruptRegistry` | `packages/domain-github/src/interrupts.ts` |
| `PromptBuilder` | `packages/domain-github/src/prompt-builder.ts` |
| `SkillRegistry` | File-based loader in `packages/domain-github/src/index.ts` |
| `PhaseRegistry` | `packages/domain-github/src/phases.ts` |
| Event source | `packages/domain-github/src/github-client.ts` (GraphQL polling) |

## Checklist

New domain author checklist:

- [ ] `types.ts` -- State, Situation, and Event types defined
- [ ] `EventProcessor` -- translates events to `EventResult` with `EventCategory`
- [ ] `SituationClassifier` -- `summarize()` returns `SituationSummary`
- [ ] `StateRenderer` -- `snapshot()`, `richSnapshot()`, `stateDiff()`, `logStateBar()`
- [ ] `InterruptRegistry` -- rules array + `createInterruptRegistry()` factory
- [ ] `PromptBuilder` -- `systemPrompt()`, `taskPrompt()`, `channelEvent()`
- [ ] `SkillRegistry` -- stub or real implementation
- [ ] `PhaseRegistry` -- at least startup + active phases; active calls `runChannelSession()` with `Effect.provide(context.domainBundle)`
- [ ] `DomainConfig` -- bundle, phaseRegistry, containerMounts, imageName
- [ ] Domain bundle -- `Layer.mergeAll(...)` of all 6 service layers
- [ ] Domain registered in `apps/roci/src/domains/registry.ts`
- [ ] Domain entry added to `config.json` at project root
- [ ] Event source connection/reconnection handled in startup phase
- [ ] `pnpm check && pnpm lint` passes
