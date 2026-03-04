# Domain Guide

How to build a new domain for the Rocinante orchestrator.

## What is a Domain?

The orchestrator is a generic plan/act/evaluate loop. It reads events from a queue, classifies the current situation, asks an LLM to plan, spawns subagents to execute steps, and evaluates results. None of this logic knows about any specific game or environment.

A **domain** plugs into this loop by implementing 7 service interfaces (plus a phase registry and config object). The core never imports domain code — services are injected via Effect tags at startup. SpaceMolt is the reference implementation; this guide explains how to build a second one.

## The 7 Services at a Glance

| # | Interface | Tag | Purpose | Difficulty |
|---|-----------|-----|---------|------------|
| 1 | `EventProcessor` | `EventProcessorTag` | Translate raw events → `EventResult` flags | Medium |
| 2 | `SituationClassifier` | `SituationClassifierTag` | Derive structured situation from state | Medium |
| 3 | `StateRenderer` | `StateRendererTag` | State → human-readable text (snapshots, diffs, console bar) | Medium |
| 4 | `InterruptRegistry` | `InterruptRegistryTag` | Declarative rules that trigger replanning | Easy |
| 5 | `ContextHandler` | `ContextHandlerTag` | Process accumulated context (chat, errors, etc.) | Easy |
| 6 | `PromptBuilder` | `PromptBuilderTag` | Assemble the 4 LLM prompts (plan, interrupt, evaluate, subagent) | Hard |
| 7 | `SkillRegistry` | `SkillRegistryTag` | Deterministic step-completion checks + task catalog | Easy (stub OK) |

Additionally:
- **`PhaseRegistry`** — defines the session lifecycle (connect → play → reflect → repeat)
- **`DomainConfig`** — bundles everything together for the orchestrator

## Step-by-Step: Building a Domain

### 1. Define Your Types (`types.ts`)

Create types for your domain's state, situation, and events. The core uses opaque `DomainState`, `DomainSituation`, and `DomainEvent` type aliases (all `unknown`), so your implementations cast internally.

```ts
// domains/mydomain/types.ts

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
  alerts: Alert[]  // always empty from classify(); alerts come from InterruptRegistry
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

Maps raw domain events into `EventResult` objects that tell the state machine what to do.

```ts
// domains/mydomain/event-processor.ts
import { Layer } from "effect"
import { EventProcessorTag, type EventResult } from "../../core/event-source.js"
import type { MyEvent } from "./types.js"

const myEventProcessor = {
  processEvent(event: unknown, _currentState: unknown): EventResult {
    const e = event as MyEvent
    switch (e.type) {
      case "state_update":
        return {
          stateUpdate: () => e.payload,
          isStateUpdate: true,
        }
      case "tick":
        return { tick: e.payload.tick, isTick: true }
      case "webhook":
        // Interrupt events can attach alerts directly
        return {
          isInterrupt: true,
          alerts: [{
            priority: "critical",
            message: `Incident: ${e.payload.title}`,
            suggestedAction: "investigate",
          }],
        }
      default:
        return {}
    }
  },
}

export const MyEventProcessorLive = Layer.succeed(EventProcessorTag, myEventProcessor)
```

Key `EventResult` fields:
- `stateUpdate?: (prev) => next` — merge function applied to the state ref
- `isStateUpdate` / `isTick` / `isInterrupt` / `isReset` — flags that route to the right handler
- `alerts?: Alert[]` — when `isInterrupt: true`, these alerts are used directly instead of querying the `InterruptRegistry`
- `accumulatedContext?: Record<string, unknown>` — data passed to `ContextHandler`
- `log?: () => void` — synchronous side effect for console logging

### 3. `SituationClassifier` — `classify()` + `briefing()`

Derives a structured situation from raw state. Called on every state update and tick.

```ts
import { Layer } from "effect"
import { SituationClassifierTag } from "../../core/situation.js"
import type { MyState, MySituation } from "./types.js"

const myClassifier = {
  classify(state: unknown): unknown {
    const s = state as MyState
    return {
      type: s.openIssues.some(i => i.severity === "critical") ? "incident" : "idle",
      flags: {
        hasCriticalBug: s.openIssues.some(i => i.severity === "critical"),
        deployPending: s.lastDeploy?.status === "pending",
      },
      alerts: [],  // always empty — alerts come from InterruptRegistry
    } satisfies MySituation
  },

  briefing(state: unknown, situation: unknown): string {
    const s = state as MyState
    const sit = situation as MySituation
    return `Project: ${s.projectName}. Status: ${sit.type}. ${s.openIssues.length} open issues.`
  },
}

export const MySituationClassifierLive = Layer.succeed(SituationClassifierTag, myClassifier)
```

**`briefing()` vs `renderForPlanning()`**: `briefing()` is a short summary passed to the brain's planning and interrupt prompts. `renderForPlanning()` (on `StateRenderer`) is the detailed state dump included in planning context. Both are called each planning cycle, but briefing is ~1 sentence while renderForPlanning can be many lines.

### 4. `StateRenderer` — Snapshots, Diffs, Console Bar

Renders state into human-readable forms for prompts, logging, and diff tracking.

```ts
import { Layer } from "effect"
import { StateRendererTag } from "../../core/state-renderer.js"

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

  renderForPlanning(state: unknown, situation: unknown): string {
    // Detailed state for the planning prompt
    const s = state as MyState
    return JSON.stringify(s, null, 2)
  },

  logStateBar(name: string, state: unknown, situation: unknown): void {
    // One-line console output per state update
    const s = state as MyState
    console.log(`[${name}] ${s.projectName} | ${s.openIssues.length} issues`)
  },
}

export const MyStateRendererLive = Layer.succeed(StateRendererTag, myRenderer)
```

### 5. `InterruptRegistry` — Rules + `createInterruptRegistry()`

Declarative rules that detect conditions warranting replanning. Use the `createInterruptRegistry()` factory from core to avoid boilerplate:

```ts
import { Layer } from "effect"
import type { InterruptRule } from "../../core/interrupt.js"
import { InterruptRegistryTag, createInterruptRegistry } from "../../core/interrupt.js"
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

### 6. `ContextHandler` — Process Accumulated Context

Processes the `accumulatedContext` map from `EventResult`. Returns a `ProcessedContext` (with optional `chatMessages`). Also a good place for logging side effects.

```ts
import { Effect, Layer } from "effect"
import { ContextHandlerTag } from "../../core/context-handler.js"
import { CharacterLog } from "../../logging/log-writer.js"

const myContextHandler = {
  processContext(context: Record<string, unknown>, char: any) {
    return Effect.gen(function* () {
      const log = yield* CharacterLog

      if (context.webhookEvent) {
        yield* log.action(char, {
          timestamp: new Date().toISOString(),
          source: "webhook",
          character: char.name,
          type: "webhook_received",
          event: context.webhookEvent,
        }).pipe(Effect.catchAll(() => Effect.void))
      }

      // chatMessages is optional — return {} if your domain has no chat
      return {}
    })
  },
}

export const MyContextHandlerLive = Layer.succeed(ContextHandlerTag, myContextHandler)
```

### 7. `PromptBuilder` — Assemble the 4 Prompts

This is the hardest service. You build 4 prompts that the brain uses:

| Prompt | When Called | Expected LLM Response Format |
|--------|-----------|------------------------------|
| `planPrompt` | Initial planning + replanning | JSON: `{ reasoning, steps: [{ task, goal, model, successCondition, timeoutTicks }] }` |
| `interruptPrompt` | Critical alert fires | Same JSON format as planPrompt |
| `evaluatePrompt` | After subagent completes a step | JSON: `{ complete: boolean, reason: string }` |
| `subagentPrompt` | Before spawning a subagent | Free-form instructions for the subagent |

See `core/prompt-builder.ts` for the exact context types (`PlanPromptContext`, `InterruptPromptContext`, `EvaluatePromptContext`, `SubagentPromptContext`).

The SpaceMolt implementation (`domains/spacemolt/prompt-builder.ts`) is the best reference — it shows how to weave state, situation, diary, background, and identity into effective prompts.

### 8. `SkillRegistry` — Stub or Implement

A stub is valid for getting started:

```ts
import { Layer } from "effect"
import { SkillRegistryTag } from "../../core/skill.js"

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

### 9. `PhaseRegistry` — Define Session Lifecycle

Phases are the top-level session structure. A minimal registry needs at least a startup phase (which connects and returns a `ConnectionState`) and an active phase (which runs the event loop).

```ts
import { Effect, Deferred, Queue } from "effect"
import type { Phase, PhaseContext, PhaseResult, PhaseRegistry, ConnectionState } from "../../core/phase.js"
import type { ExitReason } from "../../core/types.js"
import type { LifecycleHooks } from "../../core/lifecycle.js"
import { eventLoop } from "../../monitor/event-loop.js"

const startupPhase: Phase = {
  name: "startup",
  run: (context: PhaseContext) =>
    Effect.gen(function* () {
      // Connect to your event source, get initial state
      const events = yield* Queue.bounded(500)
      const initialState = { /* ... */ }

      // Start your event source (WebSocket, polling, etc.) that pushes to `events`
      // ...

      const connection: ConnectionState = { events, initialState, tickIntervalSec: 30, initialTick: 0 }
      return { _tag: "Continue", next: "active", connection } as PhaseResult
    }),
}

const activePhase: Phase = {
  name: "active",
  run: (context: PhaseContext) =>
    Effect.gen(function* () {
      if (!context.connection || !context.domainBundle) {
        return { _tag: "Shutdown" } as PhaseResult
      }
      const conn = context.connection
      const exitSignal = yield* Deferred.make<ExitReason, never>()
      const hooks: LifecycleHooks = {
        shouldExit: (turns) => Effect.succeed(turns >= 100),
      }

      yield* eventLoop({
        char: context.char,
        containerId: context.containerId,
        playerName: context.char.name,
        containerEnv: context.containerEnv,
        events: conn.events as Queue.Queue<unknown>,
        initialState: conn.initialState,
        tickIntervalSec: conn.tickIntervalSec,
        initialTick: conn.initialTick,
        exitSignal,
        hooks,
        domainBundle: context.domainBundle,
      })

      return { _tag: "Continue", next: "startup", connection: context.connection } as PhaseResult
    }),
}

const phases = [startupPhase, activePhase]

export const myPhaseRegistry: PhaseRegistry = {
  phases,
  getPhase: (name) => phases.find((p) => p.name === name),
  initialPhase: "startup",
}
```

The `domainBundle` is threaded through `PhaseContext` — pass it to `eventLoop()` so the state machine gets your service layers.

### 10. `DomainConfig` — Assemble Everything

```ts
import { Layer } from "effect"
import type { DomainConfig, DomainBundle } from "../../core/domain-bundle.js"
import { myPhaseRegistry } from "./phases.js"
// ... import all your Layer exports

export const myDomainBundle: DomainBundle = Layer.mergeAll(
  MyEventProcessorLive,
  MySituationClassifierLive,
  MyStateRendererLive,
  MyInterruptRegistryLive,
  MyContextHandlerLive,
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

To wire it up, update `cli.ts` to import your domain config instead of (or alongside) SpaceMolt's.

## Implicit Contracts

Things the type system doesn't enforce but your domain must respect:

### `accumulatedContext` Keys

`EventProcessor.processEvent()` returns `accumulatedContext: Record<string, unknown>`. `ContextHandler.processContext()` receives that same record. There's no schema — keys must match by convention between the two. Document your keys.

### `planPrompt` Response Format

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

### `evaluatePrompt` Response Format

The brain parses evaluate responses as JSON:

```json
{
  "complete": true,
  "reason": "cargo was sold successfully"
}
```

This is parsed by `brain.ts:brainEvaluate`.

### `briefing()` vs `renderForPlanning()`

- `briefing()` (SituationClassifier): ~1 sentence summary, used in planning and interrupt prompts as quick context
- `renderForPlanning()` (StateRenderer): detailed state dump, included in the full planning context

Both are called each planning cycle.

### `situation.alerts` Should Be Empty from `classify()`

The `classify()` method should return `alerts: []`. Alerts are owned by the `InterruptRegistry` — they're evaluated separately by the state machine. The alerts field on your situation type is for your own domain-internal use if needed, but the state machine doesn't read it.

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
  alerts: Alert[]
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
    // same pattern as the template in section 9
  }),
}
```

## Reference: SpaceMolt Implementation Map

| Service | SpaceMolt File |
|---------|---------------|
| `EventProcessor` | `domains/spacemolt/event-processor.ts` |
| `SituationClassifier` | `domains/spacemolt/situation.ts` → `situation-classifier.ts` |
| `StateRenderer` | `domains/spacemolt/renderer.ts` → `state-renderer.ts` |
| `InterruptRegistry` | `domains/spacemolt/interrupts.ts` |
| `ContextHandler` | `domains/spacemolt/context-handler.ts` |
| `PromptBuilder` | `domains/spacemolt/prompt-builder.ts` |
| `SkillRegistry` | Stub in `domains/spacemolt/index.ts` |
| `PhaseRegistry` | `domains/spacemolt/phases.ts` |
| `DomainConfig` | `domains/spacemolt/config.ts` |
| Domain bundle | `domains/spacemolt/index.ts` |
| Domain types | `domains/spacemolt/types.ts` + `ws-types.ts` |
| Event source (WebSocket) | `domains/spacemolt/game-socket-impl.ts` |
| Briefing helper | `domains/spacemolt/briefing.ts` |

Note: SpaceMolt has a wrapper pattern where `situation.ts` wraps `situation-classifier.ts` and `renderer.ts` wraps `state-renderer.ts`. This is a SpaceMolt organizational choice, not a requirement.

## Container Architecture

Each domain runs in its own Docker container named `roci-<domain>` (e.g. `roci-spacemolt`, `roci-github`). Characters within a domain share a container.

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

1. Create `orchestrator/src/domains/<name>/docker/Dockerfile` and `init-firewall.sh`
2. Set `dockerfilePath` and `dockerContext` in your `DomainConfig`
3. The orchestrator builds images automatically, deduplicated by `imageName`

## Checklist

New domain author checklist:

- [ ] `types.ts` — State, Situation, and Event types defined
- [ ] `EventProcessor` — translates events → `EventResult`
- [ ] `SituationClassifier` — `classify()` returns situation with `alerts: []`; `briefing()` returns short summary
- [ ] `StateRenderer` — `snapshot()`, `richSnapshot()`, `stateDiff()`, `renderForPlanning()`, `logStateBar()`
- [ ] `InterruptRegistry` — rules array + `createInterruptRegistry()` factory
- [ ] `ContextHandler` — processes `accumulatedContext` keys (or returns `{}`)
- [ ] `PromptBuilder` — 4 prompts (`planPrompt`, `interruptPrompt`, `evaluatePrompt`, `subagentPrompt`)
- [ ] `SkillRegistry` — stub or real implementation
- [ ] `PhaseRegistry` — at least startup + active phases; active phase passes `context.domainBundle` to `eventLoop()`
- [ ] `DomainConfig` — bundle, phaseRegistry, containerMounts, imageName, serviceLayer, dockerfilePath, dockerContext, containerAddDirs
- [ ] Domain bundle — `Layer.mergeAll(...)` of all 7 service layers
- [ ] Domain registered in `orchestrator/src/domains/registry.ts`
- [ ] Domain entry added to `config.json` at project root
- [ ] `planPrompt` instructs LLM to return `{ reasoning, steps: [{ task, goal, model, successCondition, timeoutTicks }] }`
- [ ] `evaluatePrompt` instructs LLM to return `{ complete: boolean, reason: string }`
- [ ] `accumulatedContext` keys match between `EventProcessor` and `ContextHandler`
- [ ] Event source connection/reconnection handled in startup phase
- [ ] `npm run check && npm run lint` passes
