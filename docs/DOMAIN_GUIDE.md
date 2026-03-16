# Domain Guide

How to build a new domain for the Rocinante orchestrator. New domains should be created as workspace packages under `packages/domain-<name>/` (e.g. `packages/domain-mydomain/`), with the package name `@signal/domain-<name>`. Domain code imports from `@signal/core` instead of relative paths.

## What is a Domain?

The orchestrator is a generic engine for running autonomous character-driven sessions. It reads events from a queue, classifies the current situation, and drives agent work cycles. Two execution models are available: a **state machine** (reactive plan/act/evaluate loop) and a **planned-action** engine (batch brain/body cycles with breaks). None of this logic knows about any specific game or environment.

A **domain** plugs into this engine by implementing 6 service interfaces (plus a phase registry and config object). The core never imports domain code — services are injected via Effect tags at startup. SpaceMolt (state machine) and GitHub (planned-action) are the two reference implementations.

## The 6 Services at a Glance

| # | Interface | Tag | Purpose | Difficulty |
|---|-----------|-----|---------|------------|
| 1 | `EventProcessor` | `EventProcessorTag` | Translate raw events → `EventResult` with `EventCategory` | Medium |
| 2 | `SituationClassifier` | `SituationClassifierTag` | Derive `SituationSummary` (headline, sections, metrics) from state | Medium |
| 3 | `StateRenderer` | `StateRendererTag` | State → human-readable text (snapshots, diffs, console bar) | Medium |
| 4 | `InterruptRegistry` | `InterruptRegistryTag` | Declarative rules that trigger replanning | Easy |
| 5 | `PromptBuilder` | `PromptBuilderTag` | Assemble LLM prompts (plan, interrupt, evaluate, subagent, brain) | Hard |
| 6 | `SkillRegistry` | `SkillRegistryTag` | Deterministic step-completion checks + task catalog | Easy (stub OK) |

Additionally:
- **`PhaseRegistry`** — defines the session lifecycle (connect → play → reflect → repeat)
- **`TempoConfig`** — timing parameters for the execution engine (see "Execution Models" below)
- **`DomainConfig`** — bundles everything together for the orchestrator

## Execution Models

Domains choose one of two core engines. Your active phase calls the chosen engine; the engine pulls services from the `DomainBundle` you provide.

### State Machine (`runStateMachine`)

A reactive event loop: read events from a queue, plan a sequence of steps, spawn subagents to execute each step, evaluate completion, replan on interrupts. Used by **SpaceMolt**.

Configured with `StateMachineTempo`:
```ts
interface StateMachineTempo {
  _tag: "StateMachine"
  tickIntervalSec: number     // heartbeat / polling interval
  maxTurns: number             // exit after this many event-loop turns
  dreamThreshold: number       // diary lines before triggering dream compression
}
```

### Planned-Action (`runPlannedAction`)

A batch brain/body cycle: drain pending events, build a brain prompt from state + identity, run a brain session (Opus plans), then a body session (Sonnet executes), repeat for N cycles, then take a break. Used by **GitHub**.

Configured with `PlannedActionTempo`:
```ts
interface PlannedActionTempo {
  _tag: "PlannedAction"
  tickIntervalSec: number       // heartbeat / polling interval
  maxCycles: number             // brain/body cycles per active phase
  breakDurationMs: number       // rest period between active phases
  breakPollIntervalSec: number  // how often to check for critical interrupts during break
  dreamThreshold: number        // diary lines before triggering dream compression
}
```

Both types extend `TempoBase` (`tickIntervalSec`, `dreamThreshold`). The discriminant is `_tag`.

## Step-by-Step: Building a Domain

### 1. Define Your Types (`types.ts`)

Create types for your domain's state, situation, and events. The core uses opaque `DomainState`, `DomainSituation`, and `DomainEvent` type aliases (all `unknown`), so your implementations cast internally.

```ts
// packages/domain-mydomain/src/types.ts

/** The full state snapshot for your domain. */
export interface MyState {
  // whatever your domain tracks
  projectName: string
  openIssues: Issue[]
  lastDeploy: DeployInfo | null
  tick: number
  timestamp: number
}

/** Classified situation derived from state. */
export interface MySituation {
  type: MySituationType
  flags: {
    hasCriticalBug: boolean
    deployPending: boolean
    // ...
  }
}

export enum MySituationType {
  Idle = "idle",
  Deploying = "deploying",
  Incident = "incident",
}

/** Raw events from your event source (WebSocket, webhook, polling, etc.). */
export type MyEvent =
  | { type: "state_update"; payload: MyState }
  | { type: "webhook"; payload: WebhookPayload }
  | { type: "tick"; payload: { tick: number } }
```

### 2. `EventProcessor` — Translate Events

Maps raw domain events into `EventResult` objects that tell the engine how to react.

```ts
// packages/domain-mydomain/src/event-processor.ts
import { Layer } from "effect"
import { EventProcessorTag, type EventResult } from "@signal/core/core/limbic/thalamus/event-processor.js"
import type { MyEvent } from "./types.js"

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
      case "lifecycle_reset":
        return {
          category: { _tag: "LifecycleReset", reason: "Session ended" },
        }
      default:
        return {}
    }
  },
}

export const MyEventProcessorLive = Layer.succeed(EventProcessorTag, myEventProcessor)
```

`EventResult` uses a discriminated union `EventCategory` instead of boolean flags:

```ts
type EventCategory =
  | { _tag: "Heartbeat"; tick: number }
  | { _tag: "StateChange" }
  | { _tag: "LifecycleReset"; reason: string }

interface EventResult {
  category?: EventCategory            // what kind of event this is
  stateUpdate?: (prev) => next        // merge function applied to the state ref
  context?: DomainContext              // typed context (e.g. chatMessages)
  log?: () => void                    // synchronous side effect for console logging
}
```

`DomainContext` is a typed interface (currently carries optional `chatMessages`), replacing the old untyped `accumulatedContext` map.

### 3. `SituationClassifier` — `summarize()`

Derives a structured `SituationSummary` from raw state. Called on every state change and at the start of each brain/body cycle.

```ts
import { Layer } from "effect"
import { SituationClassifierTag } from "@signal/core/core/limbic/thalamus/situation-classifier.js"
import type { SituationSummary } from "@signal/core/core/limbic/thalamus/situation-classifier.js"
import type { MyState, MySituation } from "./types.js"

const myClassifier = {
  summarize(state: unknown): SituationSummary {
    const s = state as MyState
    const situation: MySituation = {
      type: s.openIssues.some(i => i.severity === "critical") ? "incident" : "idle",
      flags: {
        hasCriticalBug: s.openIssues.some(i => i.severity === "critical"),
        deployPending: s.lastDeploy?.status === "pending",
      },
    }

    return {
      situation,
      headline: `${s.projectName}: ${situation.type} — ${s.openIssues.length} open issues`,
      sections: [
        {
          id: "issues",
          heading: "Open Issues",
          body: s.openIssues.map(i => `- [${i.severity}] ${i.title}`).join("\n"),
        },
      ],
      metrics: {
        issueCount: s.openIssues.length,
        ciFailing: s.ciStatus === "red",
        deployPending: s.lastDeploy?.status === "pending" ?? false,
      },
    }
  },
}

export const MySituationClassifierLive = Layer.succeed(SituationClassifierTag, myClassifier)
```

The `SituationSummary` shape:
- **`situation`** — your domain-specific situation object (opaque to the core)
- **`headline`** — one-line summary used in brain prompts and logging
- **`sections`** — structured content blocks for detailed brain prompts (each has `id`, `heading`, `body`)
- **`metrics`** — key/value pairs passed to `StateRenderer.logStateBar()` for console output

### 4. `StateRenderer` — Snapshots, Diffs, Console Bar

Renders state into human-readable forms for diff tracking and logging. Detailed state for prompts is now handled by `SituationSummary.sections` (from the classifier).

```ts
import { Layer } from "effect"
import { StateRendererTag } from "@signal/core/core/state-renderer.js"

const myRenderer = {
  snapshot(state: unknown): Record<string, unknown> {
    const s = state as MyState
    return { project: s.projectName, issues: s.openIssues.length }
  },

  richSnapshot(state: unknown): Record<string, unknown> {
    // Include everything needed for meaningful diffs
    const s = state as MyState
    return { ...s }
  },

  stateDiff(before: Record<string, unknown> | null, after: Record<string, unknown>): string {
    if (!before) return "(initial state)"
    // Return human-readable summary of what changed
    return `Issues: ${before.issues} → ${(after as any).issues}`
  },

  logStateBar(name: string, metrics: Record<string, string | number | boolean>): void {
    // One-line console output — `metrics` comes from SituationSummary.metrics
    console.log(`[${name}] issues=${metrics.issueCount} ci=${metrics.ciFailing ? "red" : "green"}`)
  },
}

export const MyStateRendererLive = Layer.succeed(StateRendererTag, myRenderer)
```

Note: `logStateBar` receives the `metrics` record from `SituationSummary`, not the raw state and situation. This keeps the renderer decoupled from the situation classifier's internals.

### 5. `InterruptRegistry` — Rules + `createInterruptRegistry()`

Declarative rules that detect conditions warranting replanning. Use the `createInterruptRegistry()` factory from core to avoid boilerplate:

```ts
import { Layer } from "effect"
import type { InterruptRule } from "@signal/core/core/limbic/amygdala/interrupt.js"
import { InterruptRegistryTag, createInterruptRegistry } from "@signal/core/core/limbic/amygdala/interrupt.js"
import type { MyState, MySituation } from "./types.js"

const rules: ReadonlyArray<InterruptRule> = [
  {
    name: "critical_bug",
    priority: "critical",
    condition: (state) => (state as MyState).openIssues.some(i => i.severity === "critical"),
    message: () => "Critical bug detected — investigate immediately.",
    suggestedAction: "investigate",
    suppressWhenTaskIs: "investigate",  // don't re-trigger if already investigating
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

const myInterruptRegistry = createInterruptRegistry(rules)

export const MyInterruptRegistryLive = Layer.succeed(InterruptRegistryTag, myInterruptRegistry)
```

The factory handles: iterating rules, checking conditions, building `Alert` objects, respecting `suppressWhenTaskIs`, and sorting by priority (critical > high > medium > low).

### 6. `PromptBuilder` — Assemble the Prompts

This is the hardest service. The methods you need depend on your execution model.

**State machine domains** use these 5 methods:

| Method | When Called | Expected LLM Response Format |
|--------|-----------|------------------------------|
| `planPrompt` | Initial planning + replanning | JSON: `{ reasoning, steps: [{ task, goal, model, successCondition, timeoutTicks }] }` |
| `interruptPrompt` | Critical alert fires | Same JSON format as planPrompt |
| `evaluatePrompt` | After subagent completes a step | JSON: `{ complete: boolean, reason: string }` |
| `subagentPrompt` | Before spawning a subagent | Free-form instructions for the subagent |
| `systemPrompt` | Container system prompt for each subagent run | Free-form system prompt |

**Planned-action domains** additionally use:

| Method | When Called | Expected LLM Response Format |
|--------|-----------|------------------------------|
| `brainPrompt` | Each planned-action cycle, before the brain session | Free-form briefing for the brain |

The `brainPrompt` receives a `PlannedActionBrainPromptContext` with the `SituationSummary`, diary, background, values, cycle number, max cycles, soft alerts, and state diff. It should produce a complete briefing document that the brain session uses to decide what work to direct the body to do.

State machine domains can stub `brainPrompt` with a throw (it will never be called). Planned-action domains typically stub the state-machine-only methods (`planPrompt`, `interruptPrompt`, `evaluatePrompt`, `subagentPrompt`) the same way.

See `core/prompt-builder.ts` for the exact context types (`PlanPromptContext`, `InterruptPromptContext`, `EvaluatePromptContext`, `SubagentPromptContext`, `PlannedActionBrainPromptContext`).

The SpaceMolt implementation (`packages/domain-spacemolt/src/prompt-builder.ts`) is the best reference for state machine prompts. The GitHub implementation (`packages/domain-github/src/prompt-builder.ts`) is the reference for planned-action prompts.

### 7. `SkillRegistry` — Stub or Implement

A stub is valid for getting started:

```ts
import { Layer } from "effect"
import { SkillRegistryTag } from "@signal/core/core/skill.js"

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

With a stub, all step completion falls through to the LLM evaluator (`brain.evaluate`). Real skills provide deterministic completion checks — useful when state changes are machine-verifiable (e.g., "cargo sold" can be checked by comparing cargo counts).

### 8. `PhaseRegistry` — Define Session Lifecycle

Phases are the top-level session structure. A minimal registry needs at least a startup phase (which connects and returns a `ConnectionState`) and an active phase (which runs the chosen engine).

**Active phases should be thin.** They configure the engine and call it — they should not reimplement orchestration logic. The core engine (`runStateMachine` or `runPlannedAction`) handles event draining, state classification, interrupt detection, brain/body execution, and logging.

#### State Machine Pattern (SpaceMolt-style)

```ts
import { Effect, Deferred, Queue } from "effect"
import { runStateMachine } from "@signal/core/core/orchestrator/state-machine.js"

const activePhase = {
  name: "active",
  run: (context: PhaseContext) =>
    Effect.gen(function* () {
      if (!context.connection || !context.domainBundle) {
        return { _tag: "Shutdown" } as PhaseResult
      }
      const conn = context.connection
      const exitSignal = yield* Deferred.make<ExitReason, never>()

      yield* runStateMachine({
        char: context.char,
        containerId: context.containerId,
        playerName: context.char.name,
        containerEnv: context.containerEnv,
        events: conn.events as Queue.Queue<unknown>,
        initialState: conn.initialState,
        tickIntervalSec: conn.tickIntervalSec,
        initialTick: conn.initialTick,
        exitSignal,
        hooks: { shouldExit: (turns) => Effect.succeed(turns >= 100) },
      }).pipe(Effect.provide(context.domainBundle))

      return { _tag: "Continue", next: "social", connection: context.connection } as PhaseResult
    }),
}
```

#### Planned-Action Pattern (GitHub-style)

```ts
import { runPlannedAction } from "@signal/core/core/orchestrator/planned-action.js"
import type { PlannedActionTempo } from "@signal/core/core/limbic/hypothalamus/tempo.js"

const tempo: PlannedActionTempo = {
  _tag: "PlannedAction",
  tickIntervalSec: 30,
  maxCycles: 3,
  breakDurationMs: 90 * 60 * 1000,
  breakPollIntervalSec: 5,
  dreamThreshold: 200,
}

const activePhase = {
  name: "active",
  run: (context: PhaseContext) =>
    Effect.gen(function* () {
      if (!context.connection || !context.domainBundle) {
        return { _tag: "Shutdown" } as PhaseResult
      }
      const conn = context.connection

      const result = yield* runPlannedAction({
        char: context.char,
        containerId: context.containerId,
        containerEnv: context.containerEnv,
        events: conn.events as Queue.Queue<unknown>,
        initialState: conn.initialState as unknown,
        tempo,
        brainSystemPrompt: "...",
        bodySystemPrompt: "...",
        brainModel: "opus",
        bodyModel: "sonnet",
        brainTimeoutMs: 8 * 60 * 1000,
        bodyTimeoutMs: 15 * 60 * 1000,
      }).pipe(Effect.provide(context.domainBundle!))

      const updatedConnection = { ...conn, initialState: result.finalState }
      if (result._tag === "Interrupted") {
        return { _tag: "Continue", next: "active", connection: updatedConnection } as PhaseResult
      }
      return { _tag: "Continue", next: "break", connection: updatedConnection } as PhaseResult
    }),
}
```

The key pattern in both cases: **`Effect.provide(context.domainBundle)`** — this injects your 6 service layers into the engine so it can access EventProcessor, SituationClassifier, etc.

Planned-action domains typically add `break` and `reflection` phases alongside `active`. The core provides `runBreak` (polls for critical interrupts during rest) and `runReflection` (dream compression) as reusable building blocks.

### 9. `DomainConfig` — Assemble Everything

```ts
import { Layer } from "effect"
import type { DomainConfig, DomainBundle } from "@signal/core/core/domain-bundle.js"
import { myPhaseRegistry } from "./phases.js"
// ... import all your Layer exports

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
    // ... your mounts
  ],
  imageName: "my-domain-player",
})
```

Register your domain in `apps/signal/src/domains/registry.ts` — one line in `DOMAIN_REGISTRY`:

```ts
export const DOMAIN_REGISTRY: Record<string, DomainConfigFactory> = {
  spacemolt: spaceMoltDomainConfig,
  github: gitHubDomainConfig,
  mydomain: myDomainConfig,  // <-- add here
}
```

Then add an entry to `config.json` at the project root with your domain name and character list.

## Implicit Contracts

Things the type system doesn't enforce but your domain must respect:

### `DomainContext` from `EventResult`

`EventProcessor.processEvent()` can return a `context` field of type `DomainContext`. Currently this carries optional `chatMessages`. If your domain has chat-like input, populate this; otherwise omit it.

### `planPrompt` Response Format (State Machine Domains)

The brain parses plan responses as JSON. Your `planPrompt` must instruct the LLM to return:

```json
{
  "reasoning": "why this plan makes sense",
  "steps": [
    {
      "task": "task_name",
      "goal": "what to accomplish",
      "model": "haiku",
      "successCondition": "how to know it worked",
      "timeoutTicks": 10
    }
  ]
}
```

This is parsed by `brain.ts:parsePlan()`. Missing fields get defaults (`model: "haiku"`, `timeoutTicks: 10`).

### `evaluatePrompt` Response Format (State Machine Domains)

The brain parses evaluate responses as JSON:

```json
{
  "complete": true,
  "reason": "cargo was sold successfully"
}
```

This is parsed by `brain.ts:brainEvaluate`.

### `SituationSummary` Structure

`summarize()` returns all state context the brain needs. The `headline` is a short summary (~1 sentence). The `sections` array provides structured detail for brain prompts. The `metrics` record feeds `logStateBar()` for console output. Design your sections so the brain gets enough context to make decisions without needing raw state.

### Alerts Come from `InterruptRegistry`, Not `summarize()`

The `InterruptRegistry` owns all alert evaluation. `summarize()` should not produce alerts — it classifies state. The engine calls `interruptRegistry.evaluate()` separately after each state change.

### Soft Alert Dedup

Non-critical alerts (high/medium/low) are accumulated in a `Map` keyed by `alert.ruleName ?? alert.message`. They're drained on each planning cycle. This means the same rule won't spam the planner — it appears once until the next plan is made.

### `tickIntervalSec`

This is your heartbeat interval in seconds. Even if your domain doesn't have a traditional "tick", set it to your desired polling/heartbeat interval. It controls timeout calculations (step timeout = `timeoutTicks * tickIntervalSec`).

## Worked Example: Software Project Domain

Imagine a domain that monitors a GitHub repository — state is repo health (issues, PRs, deploy status), events come from webhooks and polling.

### Types

```ts
export interface ProjectState {
  repo: string
  openIssues: Array<{ id: number; title: string; severity: "critical" | "major" | "minor" }>
  openPRs: Array<{ id: number; title: string; author: string; reviewStatus: string }>
  lastDeploy: { sha: string; status: "success" | "failure" | "pending"; timestamp: number } | null
  ciStatus: "green" | "red" | "pending"
  tick: number
  timestamp: number
}

export interface ProjectSituation {
  type: "idle" | "incident" | "review_needed" | "deploy_ready"
  flags: {
    hasCriticalBug: boolean
    ciFailing: boolean
    stalePRs: boolean
    deployReady: boolean
  }
}

export type ProjectEvent =
  | { type: "poll_update"; payload: ProjectState }
  | { type: "tick"; payload: { tick: number } }
  | { type: "webhook_push"; payload: { sha: string; branch: string } }
  | { type: "webhook_issue"; payload: { action: string; issue: { id: number; title: string; severity: string } } }
```

### Interrupt Rules

```ts
const rules: InterruptRule[] = [
  {
    name: "critical_bug",
    priority: "critical",
    condition: (s) => (s as ProjectState).openIssues.some(i => i.severity === "critical"),
    message: (s) => {
      const bugs = (s as ProjectState).openIssues.filter(i => i.severity === "critical")
      return `${bugs.length} critical bug(s): ${bugs.map(b => b.title).join(", ")}`
    },
    suggestedAction: "investigate",
    suppressWhenTaskIs: "investigate",
  },
  {
    name: "ci_red",
    priority: "high",
    condition: (s) => (s as ProjectState).ciStatus === "red",
    message: () => "CI is failing — fix the build.",
    suggestedAction: "fix_ci",
  },
  {
    name: "stale_prs",
    priority: "low",
    condition: (_, sit) => (sit as ProjectSituation).flags.stalePRs,
    message: () => "PRs need review.",
  },
]
```

### Skeleton Phase Registry

```ts
const startupPhase = {
  name: "startup",
  run: (ctx: PhaseContext) => Effect.gen(function* () {
    // Poll GitHub API for initial state, start webhook listener
    const events = yield* Queue.bounded<ProjectEvent>(500)
    const initialState = yield* fetchRepoState()
    startWebhookListener(events)  // pushes events to queue
    return { _tag: "Continue", next: "active", connection: { events, initialState, tickIntervalSec: 60, initialTick: 0 } }
  }),
}

const activePhase = {
  name: "active",
  run: (ctx: PhaseContext) => Effect.gen(function* () {
    // same pattern as the template in section 8
  }),
}
```

## Reference: Implementation Maps

### SpaceMolt (State Machine)

| Service | File |
|---------|------|
| `EventProcessor` | `packages/domain-spacemolt/src/event-processor.ts` |
| `SituationClassifier` | `packages/domain-spacemolt/src/situation.ts` → `situation-classifier.ts` |
| `StateRenderer` | `packages/domain-spacemolt/src/renderer.ts` → `state-renderer.ts` |
| `InterruptRegistry` | `packages/domain-spacemolt/src/interrupts.ts` |
| `PromptBuilder` | `packages/domain-spacemolt/src/prompt-builder.ts` |
| `SkillRegistry` | Stub in `packages/domain-spacemolt/src/index.ts` |
| `PhaseRegistry` | `packages/domain-spacemolt/src/phases.ts` |
| `DomainConfig` | `packages/domain-spacemolt/src/config.ts` |
| Domain bundle | `packages/domain-spacemolt/src/index.ts` |
| Domain types | `packages/domain-spacemolt/src/types.ts` + `ws-types.ts` |
| Event source (WebSocket) | `packages/domain-spacemolt/src/game-socket-impl.ts` |

Note: SpaceMolt has a wrapper pattern where `situation.ts` wraps `situation-classifier.ts` and `renderer.ts` wraps `state-renderer.ts`. This is a SpaceMolt organizational choice, not a requirement.

### GitHub (Planned-Action)

| Service | File |
|---------|------|
| `EventProcessor` | `packages/domain-github/src/event-processor.ts` |
| `SituationClassifier` | `packages/domain-github/src/situation-classifier.ts` |
| `StateRenderer` | `packages/domain-github/src/renderer.ts` |
| `InterruptRegistry` | `packages/domain-github/src/interrupts.ts` |
| `PromptBuilder` | `packages/domain-github/src/prompt-builder.ts` |
| `SkillRegistry` | File-based loader in `packages/domain-github/src/index.ts` |
| `PhaseRegistry` | `packages/domain-github/src/phases.ts` |
| `DomainConfig` | `packages/domain-github/src/config.ts` |
| Domain bundle | `packages/domain-github/src/index.ts` |
| Domain types | `packages/domain-github/src/types.ts` |
| Event source (GraphQL polling) | `packages/domain-github/src/github-client.ts` |

## Container Architecture

Each domain runs in its own Docker container named `signal-<domain>` (e.g. `signal-spacemolt`, `signal-github`). Characters within a domain share a container.

### Canonical Mount Paths

| Container Path | Purpose | Required? |
|---|---|---|
| `/work/players` | Character directories | Yes |
| `/work/.claude` | Claude config | Yes (readonly) |
| `/opt/scripts` | Orchestrator scripts incl. `run-step.sh` | Yes (readonly) |
| Domain-specific | Up to each domain's `containerMounts` | No |

SpaceMolt additionally mounts `/work/shared/*` and `/work/sm-cli`. GitHub currently has no extra mounts.

### `DomainConfig` Fields for Docker

| Field | Default | Purpose |
|---|---|---|
| `imageName` | — | Docker image tag |
| `dockerfilePath` | `.devcontainer/Dockerfile` | Path to Dockerfile (relative to project root) |
| `dockerContext` | `.devcontainer` | Docker build context (relative to project root) |
| `containerMounts` | — | Volume mounts for `docker create` |
| `containerSetup` | — | Post-start hook (e.g. creating symlinks) |
| `containerAddDirs` | `[]` | Paths passed as `ROCI_ADD_DIRS` env var, read by `run-step.sh` for `--add-dir` flags |
| `serviceLayer` | — | Domain-specific Effect service layer (e.g. GameSocket, GitHubClient) |

### Adding a New Domain's Docker Image

1. Create `packages/domain-<name>/src/docker/Dockerfile` and `init-firewall.sh`
2. Set `dockerfilePath` and `dockerContext` in your `DomainConfig`
3. The orchestrator builds images automatically, deduplicated by `imageName`

## Checklist

New domain author checklist:

- [ ] `types.ts` — State, Situation, and Event types defined
- [ ] `EventProcessor` — translates events → `EventResult` with `EventCategory` discriminated union
- [ ] `SituationClassifier` — `summarize()` returns `SituationSummary` with `situation`, `headline`, `sections`, `metrics`
- [ ] `StateRenderer` — `snapshot()`, `richSnapshot()`, `stateDiff()`, `logStateBar(name, metrics)`
- [ ] `InterruptRegistry` — rules array + `createInterruptRegistry()` factory
- [ ] `PromptBuilder` — state machine: `planPrompt`, `interruptPrompt`, `evaluatePrompt`, `subagentPrompt`, `systemPrompt`; planned-action: `brainPrompt` + `systemPrompt`
- [ ] `SkillRegistry` — stub or real implementation
- [ ] `PhaseRegistry` — at least startup + active phases; active phase calls `runStateMachine()` or `runPlannedAction()` with `Effect.provide(context.domainBundle)`
- [ ] `TempoConfig` — `StateMachineTempo` or `PlannedActionTempo` defined for your execution model
- [ ] `DomainConfig` — bundle, phaseRegistry, containerMounts, imageName, serviceLayer, dockerfilePath, dockerContext, containerAddDirs
- [ ] Domain bundle — `Layer.mergeAll(...)` of all 6 service layers
- [ ] Domain registered in `apps/signal/src/domains/registry.ts`
- [ ] Domain entry added to `config.json` at project root
- [ ] (State machine) `planPrompt` instructs LLM to return `{ reasoning, steps: [{ task, goal, model, successCondition, timeoutTicks }] }`
- [ ] (State machine) `evaluatePrompt` instructs LLM to return `{ complete: boolean, reason: string }`
- [ ] Event source connection/reconnection handled in startup phase
- [ ] `pnpm check && pnpm lint` passes
