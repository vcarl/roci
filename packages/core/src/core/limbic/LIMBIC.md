# Limbic System

The limbic system is a passive sensing and signaling layer that sits between raw domain events and the **cortex loop** (`packages/core/src/cortex/loop.ts`, the `runCortex` engine). It handles data ingestion, situation classification, threat detection, agent-turn execution, and memory consolidation. It does not orchestrate -- the cortex loop resolves limbic services (`EventProcessorTag`, `SituationClassifierTag`, `InterruptRegistryTag` -- see `loop.ts:9-11,106-108`) and drives all decisions itself.

The name comes from the biological limbic system. Each subsystem maps to a brain region that performs an analogous function: the thalamus relays sensory input, the amygdala detects threats, the hypothalamus manages execution, and the hippocampus consolidates memory. These are metaphors for code organization, not a neuroscience simulation.

A fifth limbic concept -- the **hindbrain appraisal & escalation** (per-event drive tagging that feeds the loop's steering ladder) -- is documented in its own section below. Its reducer physically lives in `cortex/state.ts` for hot-loop locality, but it is conceptually the limbic appraisal layer, so it is documented here, its mental home.

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
  hypothalamus/                     Agent-turn execution and timing regulation
    index.ts                        Barrel (exports only the Tempo types)
    transport.ts                    runTransport() -- reusable docker-exec stream/race/kill transport
    payload.ts                      Per-runtime inner command + normalizer (claude / opencode)
    sdk-payload.ts                  endLine() -- shared NDJSON framing helper for the frontier worker
    process-runner.ts               runTurn() / runOpenCodeSessionTurn() -- compose payload + transport
    runtime.ts                      Runtime binary selection (claude vs opencode)
    tempo.ts                        TempoConfig discriminated union
    types.ts                        TurnConfig, TurnResult
    sdk-runner/                     In-container Agent-SDK worker (.mjs) + NDJSON protocol
  hippocampus/                      Memory consolidation
    index.ts                        Barrel
    dream.ts                        dream.execute() -- diary + secrets compression (the cull)
    consolidate.ts                  consolidate.execute() -- per-cycle diary narrative rewrite
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

The `EventCategory` discriminated union drives the cortex loop's dispatch. `Heartbeat` triggers timeout checks. `StateChange` triggers full state classification and interrupt evaluation. `LifecycleReset` clears the current plan and in-flight turn.

The `alert` field carries immediate alert text the loop can surface to the active conscious turn.

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

The cortex loop feeds `SituationSummary` into interrupt evaluation, forebrain orientation, and the console state bar.

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

Critical alerts cause the cortex loop to return `Interrupted` (exiting to the break phase), carrying the firing `Alert[]` (`loop.ts:246-254`). Soft alerts are surfaced to the running conscious turn so it can factor them into its work.

**Tag:** `InterruptRegistryTag`. Domains provide a `Layer` built from `createInterruptRegistry()`.

## Hypothalamus -- Agent-Turn Execution

The hypothalamus runs a single agent turn inside a Docker container and streams its
output back as unified events. There is **no** persistent `claude --channels` server,
no `.mcp.json` channel config, and no HTTP event POST -- the deleted `session-runner.ts`
and `cycle-runner.ts` modeled that older pipeline. The current design is a **payload +
transport** split: a swappable *payload* (which binary, which args, which normalizer)
composed with one reusable *transport* (`docker exec` + stream + race + kill).

### Transport (`transport.ts`)

`runTransport(input)` is the payload-agnostic execution core. It starts the prebuilt
command (OAuth token already baked in by the caller), then forks concurrent fibers for:

- **stderr draining** -- prevents pipe blocking; surfaces auth errors on a nonzero exit
- **stdout streaming** -- splits lines, parses stream-json, normalizes each raw line into
  unified events, accumulates the text blocks, optionally captures a value (e.g. an
  OpenCode `sessionID`) from the first matching line
- **liveness heartbeat** -- `runHeartbeat` logs a "still running" line whenever stdout is
  silent for a full interval (default `HEARTBEAT_INTERVAL_MS = 30_000`), so a wedged turn
  is visible long before the wall-clock timeout
- **exit + timeout race** -- races process exit against `timeoutMs`; on timeout it
  interrupts every fiber and returns with `timedOut: true`

It returns a `TurnResult` (`{ output, timedOut, durationMs, sessionId? }`).

### Payloads (`payload.ts`, `sdk-payload.ts`)

A *payload* is the inner command run inside the container, plus its stdout normalizer:

- `selectRuntime` / `buildInnerCommand` (`payload.ts`) assemble the `claude -p` or
  `opencode run` inner command, with tool-access flags, `--add-dir` (claude-only),
  `--system-prompt`, and the opencode network-disabling env (`OPENCODE_DISABLE_NETWORK_ENV`).
- `wrapWithTimeout` wraps any inner command in coreutils `timeout` as an in-container
  backstop, since `docker exec` does not signal-forward a host-side kill.
- `sdk-payload.ts` exposes `endLine()`, the shared `end` control-line framing reused by the frontier CLI.

### Process Runner (`process-runner.ts`) -- the primary entrypoints

`process-runner.ts` composes a payload with the transport and injects the OAuth token via
`buildExecArgs`. Its exported entrypoints:

- `runTurn(config)` -- one run-to-completion turn (`claude -p` or `opencode run`) with full
  tool access. **Live**: the hippocampus `consolidate`/`dream` passes call it (`noTools`),
  and domain body turns use it.
- `runOpenCodeSessionTurn(config, resume?)` -- one conscious-tier OpenCode session turn; the
  first turn opens the session and captures its id, a resume turn continues it. This is the
  conscious executor's per-turn mechanism (used by `conscious/conscious-thought.ts`).
The former host-side SDK-turn entrypoints (`runSdkTurn` / `runSdkSession`) have been removed:
the frontier Agent-SDK worker is now driven **in-container** by the generated `frontier` CLI
(provisioned by `conscious/frontier-cli.ts`) and invoked by the conscious executor as a
delegation tool, not through `process-runner.ts`. `services/Claude.ts` is likewise reduced to
the `ClaudeModel` type and `ClaudeError`; the old host-side `Claude.invoke` no-tools path is gone.

### Runtime Selection (`runtime.ts`)

`runtimeBinary(model)` picks `claude` vs `opencode` from the model string;
`runtimeBaseArgs(runtime, model)` builds the base CLI args. `--bare` is never used (it
disables OAuth token resolution).

### SDK Runner (`sdk-runner/`)

`sdk-runner/sdk-runner.mjs` is the in-container Agent-SDK worker: it reads NDJSON commands
(`task`/`steer`/`end`) on stdin, drives the streaming-input `query()`, and writes NDJSON
events/result on stdout. The pure protocol logic (`sdk-runner-protocol.mjs`) is unit-tested
on the host. It is installed in the image at `/home/node/sdk-runner/sdk-runner.mjs`.

> Note: `SessionConfig`/`SessionResult` (leftovers of the deleted session model) have
> now been removed from `types.ts`.

## Hippocampus -- Memory Consolidation

The hippocampus is the **working-memory** tier: it keeps the character's diary coherent and
bounded so context windows don't grow unbounded. Working memory = the diary + cull; long-term
memory = the append-only vector store reached via the `memory` CLI, a separate tier documented
in [docs/MEMORY.md](../../../../../docs/MEMORY.md). A **single unified** compression step runs
in the reflection phase (`core/orchestrator/planned-action.ts`, `runReflection`):
`dream.execute()` consolidates the diary, then culls it and secrets — one module, one
`.execute()`, one runtime.

### dream.execute()

`dream` (`dream.ts`) is the per-cycle, all-domains memory compression. It is one
orchestrated operation with three sequential local-model turns; **every turn resolves the
single `dreamCompression` role, which defaults to the local conscious-tier mlx model (opencode
runtime) — Claude is never invoked in the reflection path.**

1. **Consolidate** — read the current `DIARY.md` (prior diary plus this session's raw per-step
   appends) and rewrite it into coherent narrative entries (`skills/consolidate.md` prompt,
   `noTools`). May *grow* the file; the cull below reins it back in. A failed/blank turn keeps
   the original diary untouched and is surfaced as a structured `kind:"error"` event.
2. **Cull diary** — compress the (consolidated) diary down toward `DIARY_TARGET_LINES = 150`
   (`dream.ts:16`), clamped to **never grow** the file.
3. **Cull secrets** — same never-grows compression applied to `SECRETS.md`.

The dream type (used for the cull prompts) is probabilistic:

- **Normal** (most common) -- straightforward compression
- **Good** (roll >= 94) -- optimistic tone
- **Nightmare** (roll < secretsLines/6, max 15%) -- darker, more paranoid compression

The probability of nightmares scales with the number of secrets a character has accumulated.
Each dream type uses different prompt templates from `hippocampus/prompts/`. Every cull turn
is guarded by the same blank-turn / never-grows checks, so a timeout or bloated output keeps
the original content rather than wiping or growing the file.

**Dependencies:** `CharacterFs`, `CharacterLog` (plus the process runner / OAuth for the turns).

## Hindbrain Appraisal & Escalation -- the limbic drives

This is the limbic system's appraisal layer: the fast, pre-conscious read of *"does this
event matter, and how much?"* It is conceptually a limbic/hindbrain region (the amygdala's
calmer sibling -- graded salience rather than binary threat), so it is documented here, its
mental home. Note, however, that the **reducer physically lives in `cortex/state.ts`**, not
under `core/limbic/`: the appraisal runs on the hot path every tick, so it is co-located with
the loop state it mutates for locality. Only the drive *vocabulary* (`core/drives.ts`) sits in
the core character-template layer. This section documents both, citing across that boundary.

### 1. Drives -- what the character cares about

Drives are the reference frame the hindbrain weighs each event against. Three **innate, domain-
agnostic** drives are defined verbatim in `core/drives.ts` (`TEMPLATE_DRIVES`, severity order
safety > sustenance > agency, `CORE_DRIVE_NAMES = ["safety","sustenance","agency"]`):

- **safety** -- physical integrity, or someone targeting you personally (attack, damage, threat).
- **sustenance** -- the resources you need to keep operating (fuel, energy, money/credits, quota,
  rate budget). The drive block carries explicit anti-collapse routing (money/fuel/quota =
  sustenance, **not** safety) that lifted the 2B's drive-tagging to a stable ~85%.
- **agency** -- your freedom and ability to act (blocked, locked out, frozen, disabled, shutdown).

Domains contribute their own **domain drives** via `DomainConfig.identityTemplate.domainDrives`;
`renderDriveLines(domainDrives?)` (`drives.ts:36`) appends one `- name — description` row per
domain drive to the core block, and `parseDriveNames` recovers the closed vocabulary for
validation. The rendered block is written into the character's `DRIVES.md` (`drivesFile`,
`drives.ts:53`) at scaffold time -- the companion to `PALETTE.md` (drives = what it cares about;
palette = how it feels). The same block is the per-event observe prompt's tagging vocabulary.

### 2. Per-event appraisal -- the hindbrain observe

The hindbrain (the small/fast "2B" tier) is invoked **once per state-changing event** and
returns a single `ObserveResult` (`skills/types.ts:15`) tagging that event:

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
(`cortex/state.ts:108`) before it can drive control flow: `weight` is clamped to an integer
0–5, `drive` is validated against the closed vocabulary (unknown → `null`), `disposition`
defaults to the safe `accumulate`, and `interrupt` is coerced to a strict boolean. It is pure
and never throws.

**Inert events never reach the model.** An event that produced no `stateUpdate` is tagged
deterministically by the `INERT_APPRAISAL` fast-path (`loop.ts:92-99`) -- `discard`/weight-0,
no model call (habituation to non-salient stimuli, so noise costs nothing). Only state-changing
events are sent to the 2B observe (`loop.ts:284-292`).

### 3. The escalation ladder

Each appraised event earns a rung on an ordered ladder (`EscalationRung`, `state.ts:36`):

| Rung | Earned when (`eventRung`, `state.ts:131`) |
|------|--------------------------------------------|
| `none` | `disposition: "discard"` and below the steer threshold |
| `accumulate` | non-discard, but low salience |
| `steer` | `weight >= steer threshold` **or** `disposition: "escalate"` |
| `reorient` | `weight >= reorient threshold` |
| `interrupt` | explicit `interrupt: true` only -- **never weight alone** |

Thresholds are tunable (`DEFAULT_APPRAISAL_THRESHOLDS = { steer: 4, reorient: 5 }`,
`state.ts:53`). The 2B hindbrain is **capped at `reorient`**: the hard-`interrupt` rung is gated
behind an explicit `interrupt: true`, reserved for the amygdala / a future stronger tier / a
genuine redundant physical-attack appraisal.

`appraiseTick(results, thresholds)` (`state.ts:139`) reduces the tick's per-event appraisals
into one `HindbrainEscalation` (`state.ts:50`): the tick `rung` is the **MAX** rung across
events; `maxWeight` and `dominant` come from the highest-weight event (ties → first);
`accumulated` is the raw text of every non-discard event; `escalate` is true at `steer` or
above. The loop calls `appraiseTick` each tick and consumes the returned `HindbrainEscalation`
directly -- the seam between the limbic appraisal and the loop is **guaranteed well-formed**
every tick (never undefined; `emptyEscalation()` when there were no events or nothing salient).

### 4. How the cortex loop consumes it

Each tick, after triaging events into one `HindbrainEscalation` (`loop.ts:284-297`), the loop
takes one of two disjoint paths (`loop.ts:312-427`):

- **Idle (no active plan)** -- if anything escalated (or it's the first tick, or accumulated
  events have aged past `orientInterval` via `shouldForceOrient`), run the forebrain
  orient → conscious decide → plan/wait/discover/terminate (`loop.ts:313-369`). The dominant
  event's mood becomes the tick mood; accumulated event text feeds the orient.
- **In-session (plan active)** -- apply the graded ladder against the in-flight conscious turn
  (`loop.ts:370-427`):
  - `interrupt` → kill the in-flight turn, drop the plan, reorient now (`loop.ts:375-391`).
  - `reorient` → drop the plan so the next tick re-orients; the current turn finishes naturally
    (not interrupted) (`loop.ts:392-400`).
  - `steer` / `accumulate` → run the forebrain and store its output as a coalescing
    `pendingDirective` (`formatSteerDirective`); a `steer`-rung event bypasses the steer-cadence
    throttle, an `accumulate`-rung event steers on the normal throttle (`loop.ts:401-426`).

This in-LOOP graded route is distinct from the **amygdala critical path**: a critical interrupt
(section *Amygdala*) makes `runCortex` **return `Interrupted` and exit** to the break phase
(`loop.ts:246-254`), whereas the hindbrain `interrupt` rung stays inside the loop (kill turn,
reorient, keep running). The two are deliberately separate escalation routes.

## Barrel File Contract

All limbic services are re-exported through `core/limbic/index.ts`:

```typescript
import { EventProcessorTag, InterruptRegistryTag, dream } from '../limbic'
import type { EventResult, SituationSummary, TempoConfig } from '../limbic'
```

Exported surface by subsystem (verified against `core/limbic/index.ts`):

| Subsystem | Types | Values |
|-----------|-------|--------|
| Thalamus | `EventProcessor`, `EventResult`, `EventCategory`, `DomainContext`, `SituationClassifier`, `SituationSummary` | `EventProcessorTag`, `SituationClassifierTag` |
| Amygdala | `InterruptRule`, `InterruptRegistry`, `Alert` * | `InterruptRegistryTag`, `createInterruptRegistry` |
| Hypothalamus | `TempoConfig`, `TempoBase`, `StateMachineTempo`, `PlannedActionTempo` | *(none)* |
| Hippocampus | `DreamType`, `DreamInput`, `DreamOutput` | `dream` |

\* `Alert` is re-exported by the barrel but is sourced from `core/types.ts` (`../types.js`),
not the amygdala module.

The hypothalamus exports **only** the Tempo types -- `runTurn`, `runOpenCodeSessionTurn`,
`runTransport`, and the SDK runners are **not** re-exported through the barrel; callers
import them directly from `hypothalamus/process-runner.js`. The deleted session model's
`runSession`/`runCycle`/`SessionHandle`/`SessionResult`/`CycleConfig`/`CycleResult` are gone
from the barrel entirely; importing them per an older doc yields a missing-export error.

Internal modules (`process-runner.ts`, `transport.ts`, `payload.ts`, `sdk-payload.ts`,
`consolidate.ts`, the `sdk-runner/` worker, and the dream prompt
templates) are reached by direct import, not through the barrel.
