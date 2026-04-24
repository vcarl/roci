# Plan: Wire OODA Skills into the Channel Session Tick Loop

## Background

The limbic system is a passive service layer consumed by `runChannelSession()` on every 30-second tick:

1. **EventProcessor** — mechanical event → state update
2. **SituationClassifier** — deterministic state → structured summary
3. **InterruptRegistry** — deterministic state → prioritized alerts
4. **StateRenderer** — deterministic state → human-readable diffs
5. **PromptBuilder.channelEvent()** — assemble diff + alerts into a push payload

The OODA operating skills (observe/orient/decide/evaluate) exist as loadable templates with types, a loader, cadence guidance, and passing tests — but nothing in the tick loop invokes them. They are the planned replacement for step 5: instead of a simple channelEvent push, the orchestrator runs an LLM-powered OODA chain to decide what to push, what work to direct, and when to replan.

Additionally, `dream.execute()` only runs during the reflection phase. We want it as a built-in step of the OODA loop itself — memory consolidation is part of the cognitive cycle, not an afterthought bolted on beside it.

## Architecture: What Changes, What Stays

**Stays the same:**
- EventProcessor — mechanical event→state translation is fast and correct
- SituationClassifier — deterministic classification feeds into orient as raw material
- InterruptRegistry — fast critical detection stays as a safety rail (kills session before OODA even runs)
- StateRenderer — state diffing stays (feeds evaluate's stateDiff variable)
- SessionHandle / runSession — persistent `claude --channels` process is unchanged

**Replaces:**
- PromptBuilder.channelEvent() — replaced by orient output as the primary session-push content
- PromptBuilder.taskPrompt() — replaced by decide's plan output as work directives

**Adds:**
- OodaRunner — new module that loads skills, invokes them via `runTurn(noTools: true)`, parses JSON
- Plan tracking state in the tick loop — current plan, step index, step start tick, wait state
- Event accumulation buffer — events classified as "accumulate" by observe, drained on next orient
- Dream as a step within the OODA loop (memory consolidation phase)

## Key Design Decision: Evaluate Inputs from Observable State

The session is a black box — the orchestrator cannot see the session's internal reasoning or ask it to self-report. Evaluate's inputs come entirely from what the orchestrator can observe externally:

**`{{stateDiff}}`** — `StateRenderer.stateDiff()` comparing domain state snapshots from the step's start tick to the current tick. This is the primary evidence: what changed in the world (new commits, PR status changes, CI results, cargo sold, etc.).

**`{{executionReport}}`** — Built from two sources the orchestrator already captures:
1. **Tool call events** from stream-json stdout. The `streamFiber` in session-runner.ts already parses every `tool_use` and `tool_result` into `UnifiedEvent`s and routes them to the log. To make them available to evaluate, accumulate them into a shared buffer (via `Ref<UnifiedEvent[]>`) that the tick loop drains per-tick. Format as a chronological summary: "Bash: git commit ..., Edit: src/auth/refresh.ts, Bash: npm test — exit 0".
2. **Subagent activity** from activity.log. The `activityFiber` already tails this file every 2 seconds and emits `subagent_start`/`subagent_stop` events. Include these in the report.

**`{{conditionCheck}}`** — `SkillRegistry.isStepComplete()`, which is deterministic. Most implementations fall through to "no deterministic check" (advisory), which is fine — evaluate treats it as one signal among several.

This approach is reliable because it depends on no session cooperation. The session doesn't need to call a `report` tool or format its output specially. The orchestrator observes what happened and lets the evaluate LLM judge it.

**Implementation note for Step 3 (OodaRunner):** The `runSession` stream fiber needs a small change — in addition to logging events, it should append tool_use/tool_result events to a `Ref` that the tick loop can drain. This is a ~10-line change to session-runner.ts (add a `Ref.make<UnifiedEvent[]>([])` to the session handle, push relevant events in the stream fiber, expose a `drainEvents()` method on SessionHandle).

## Key Design Decision: Batched Observe

The observe skill template is designed for a single event, but running a separate LLM call per drained event per tick is too expensive and slow. Instead, batch all events drained in a tick into a single observe invocation:

```
## Incoming Events (this tick)

Event 1: [type] [payload]
Event 2: [type] [payload]
...

Classify the batch. If ANY event warrants escalation, escalate.
```

This means modifying the observe template to accept `{{events}}` (plural) instead of `{{eventType}}` + `{{eventPayload}}`. The observe result shape stays the same — a single disposition for the batch. The emotional weight reflects the aggregate gut reaction.

If no events were drained (empty tick), skip observe entirely and use the previous disposition (accumulate by default).

## Tick Loop: Before and After

### Current (channel-session.ts)

```
while (true):
  1. Drain events → EventProcessor.processEvent() for each
  2. classifier.summarize(state)
  3. interruptRegistry.evaluate() → criticals kill session
  4. renderer.richSnapshot() + stateDiff()
  5. promptBuilder.channelEvent() → push to session
  6. Sleep 30s
```

### After

```
while (true):
  1. Drain events → EventProcessor.processEvent() for each (unchanged)
  2. interruptRegistry.evaluate() → criticals kill session (unchanged, runs BEFORE ooda)

  ── OODA LOOP ──────────────────────────────────────────────

  3. OBSERVE — IF events drained: run OBSERVE on event batch → discard/accumulate/escalate
     - discard: skip orient/decide, just push a minimal heartbeat
     - accumulate: buffer events, carry emotional weight forward
     - escalate: trigger orient+decide this tick

  4. ORIENT + DECIDE — IF escalate OR orient_interval exceeded:
     a. classifier.summarize(state) — feeds into orient as domainState
     b. renderer.richSnapshot() + stateDiff() — for evaluate later
     c. Run ORIENT(accumulated events, domainState, identity, emotional weight) → situation assessment
     d. Run DECIDE(orient output, current plan state, available skills) → plan/continue/wait/terminate
     e. Push orient headline + decide output to session as channel event
     f. Clear accumulation buffer
     g. Increment oodaCycleCount

  5. EVALUATE — IF plan active AND step tick budget expired:
     a. Run EVALUATE(step, execution report, state diff, condition check) → judgment + transition
     b. On next_step: advance step index, push next step to session
     c. On replan: clear plan, trigger orient+decide next tick
     d. On wait: enter wait state, pass to observe for resolution detection
     e. On terminate: end session gracefully
     f. If result.diaryEntry is present: read current diary via charFs.readDiary(config.char),
        append the new entry, and write back via charFs.writeDiary(config.char, updatedDiary)

  6. DREAM — IF dream is due (see "Dream as OODA Step" below):
     a. Run dream.execute() — compress diary + secrets
     b. Reset dream timer

  ── END OODA ───────────────────────────────────────────────

  7. Sleep 30s
```

### Dream as OODA Step

Dream (memory consolidation) is a built-in phase of the OODA loop, not a separate timer. It triggers based on two conditions, whichever comes first:

1. **Cycle-based**: every N completed OODA cycles (default: every 2nd cycle). A "completed cycle" means orient+decide actually ran — ticks where observe returns discard/accumulate don't count. This ties consolidation to cognitive activity: agents that are actively thinking and planning also consolidate frequently.

2. **Time-based ceiling**: a maximum number of ticks since the last dream (default: 120 ticks = ~60 minutes). This catches cases where the agent is in a long wait/continue state and OODA cycles aren't completing — memory still gets consolidated even during idle periods.

```typescript
// Dream trigger logic
const dreamDue =
  config.dream && (
    oodaCycleCount - lastDreamCycle >= (config.dream.cycleInterval ?? 2) ||
    tickNumber - lastDreamTick >= (config.dream.maxIntervalTicks ?? 120)
  )
```

This means:
- An active agent running orient+decide every few ticks will dream roughly every other full cycle
- An idle agent accumulating heartbeats will dream at most once per hour
- A newly started session won't dream on tick 1 (both counters start at 0)

## Implementation Steps

### Step 1: Add SkillRegistryTag to DomainBundle

**File:** `packages/core/src/core/domain-bundle.ts`

The `DomainBundle` type currently omits `SkillRegistryTag`, but both domain implementations include it via `Layer.mergeAll`. Add it to the type so `channel-session.ts` can `yield* SkillRegistryTag` to access domain skills for decide's `availableSkills` variable.

```typescript
export type DomainBundle = Layer.Layer<
  | EventProcessorTag
  | SituationClassifierTag
  | StateRendererTag
  | InterruptRegistryTag
  | PromptBuilderTag
  | SkillRegistryTag,  // <-- add
  never,
  never
>;
```

Verify both domain bundles still type-check after this change.

### Step 2: Modify observe template for batch events

**File:** `packages/core/src/skills/observe.md`

Replace the single-event variables:
```
## Incoming Event
Type: {{eventType}}
{{eventPayload}}
```

With batch format:
```
## Incoming Events

{{events}}
```

Where `{{events}}` is pre-formatted by the caller as:
```
[Event 1] type: poll_update
{...payload...}

[Event 2] type: tick
{...payload...}
```

Also add to the instructions: "If ANY event in the batch warrants escalation, escalate. Your emotional weight should reflect the aggregate reaction across all events."

Update the observe smoke test to use the new `events` variable instead of `eventType`+`eventPayload`.

### Step 3: Create OodaRunner module

**New file:** `packages/core/src/core/ooda-runner.ts`

This module loads the 4 skill templates and provides methods to invoke each one:

```typescript
interface OodaConfig {
  containerId: string
  playerName: string
  char: CharacterConfig
  cadence: Cadence
  models: ModelConfig
  addDirs?: string[]
  env?: Record<string, string>
}

interface OodaState {
  accumulatedEvents: string[]     // event descriptions since last orient
  emotionalWeight: string         // carried from observe to orient
  currentPlan: DecideResult | null
  currentStepIndex: number
  stepStartTick: number
  waitState: WaitState | null
  lastOrientTick: number
}

// invoke functions — each calls runTurn(noTools: true) and parses JSON
function runObserve(config, events: string[], waitState): Effect<ObserveResult>
function runOrient(config, state: OodaState, domainState, summary, identity): Effect<OrientResult>
function runDecide(config, orientResult, planState, availableSkills): Effect<DecideResult>
function runEvaluate(config, step, executionReport, stateDiff, conditionCheck, emotionalState, remainingSteps): Effect<EvaluateResult>
```

Each function:
1. Loads the skill template via `loadSkillSync()`
2. Builds the variable record (injecting cadence guidance via `getCadenceGuidance()`)
3. Calls `skill.render(vars)` to produce the prompt
4. Calls `runTurn({ ..., prompt, noTools: true, model: resolveModel(...) })` — observe/orient use `fast` tier, decide/evaluate use `reasoning` tier
5. Extracts JSON from the response (handle markdown code fences)
6. Parses and returns the typed result

**JSON extraction:** LLMs often wrap JSON in ```json code fences. Add a utility function:
```typescript
function extractJson(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  return match ? match[1].trim() : text.trim()
}
```

**Error handling:** If JSON parsing fails, log the raw output and fall back to a safe default (discard for observe, continue for decide). Do not crash the tick loop.

**SessionHandle change:** Add a `drainEvents()` method to `SessionHandle` that returns and clears accumulated `tool_use`/`tool_result` events. Implementation: add a `Ref<UnifiedEvent[]>` to session-runner.ts, push relevant events in the `streamFiber`'s `mapEffect`, and expose a drain function on the handle. This is ~10 lines of change and provides the raw material for evaluate's `{{executionReport}}`.

### Step 4: Add configuration to ChannelSessionConfig

**File:** `packages/core/src/core/orchestrator/channel-session.ts`

Add to `ChannelSessionConfig`:
```typescript
interface ChannelSessionConfig {
  // ...existing fields...

  /** Domain cadence: "real-time" or "planned-action". Affects OODA skill behavior. */
  cadence?: Cadence
  /** Model config for OODA skill invocations. */
  models?: ModelConfig
  /** Dream configuration. If provided, enables dream as a step within the OODA loop. */
  dream?: {
    /** Run dream every N completed OODA cycles. Default: 2 (every other orient+decide). */
    cycleInterval?: number
    /** Maximum ticks between dreams regardless of OODA cycle count. Default: 120 (~60 min). */
    maxIntervalTicks?: number
  }
  /** How many ticks of accumulated events before forcing an orient, even without escalation. Default: 5. */
  orientInterval?: number
}
```

### Step 5: Refactor channel-session.ts tick loop

**File:** `packages/core/src/core/orchestrator/channel-session.ts`

This is the largest change. The tick loop gains OODA state tracking and skill invocations.

**New state variables:**
```typescript
let oodaState: OodaState = {
  accumulatedEvents: [],
  emotionalWeight: "",
  currentPlan: null,
  currentStepIndex: 0,
  stepStartTick: 0,
  waitState: null,
  lastOrientTick: 0,
}
```

**Tick loop changes (see "Tick Loop: After" above for the full flow):**

Key integration points:

a) After event drain (step 1): format drained events as strings for observe input. Each event gets a one-line summary from EventProcessor's log side effect or a JSON.stringify fallback.

b) After interrupt check (step 2): run observe if events were drained. If observe returns "discard", push a minimal heartbeat to the session and skip to sleep. If "accumulate", add to buffer. If "escalate", set a flag to trigger orient+decide.

c) Orient trigger (step 4): runs when escalate flag is set OR `tickNumber - oodaState.lastOrientTick >= orientInterval`. Orient uses SituationClassifier.summarize() as the `domainState` input. Identity (background, values, diary) is read from CharacterFs. The accumulated events buffer is formatted and passed as `accumulatedEvents`.

d) Decide runs immediately after orient. Receives orient's output, SkillRegistry.taskList() as availableSkills, and the current plan state. If decide returns "plan", store the plan in oodaState and push the first step's instructions to the session. If "continue", push a status update. If "wait", enter wait state. If "terminate", end the session.

e) Evaluate trigger (step 5): when `oodaState.currentPlan` is active and the current step's tick budget is exhausted (`tickNumber - oodaState.stepStartTick >= step.timeoutTicks`). Inputs:
   - `{{stateDiff}}` — `renderer.stateDiff(stepStartSnapshot, currentSnapshot)`, comparing state at step start vs now
   - `{{executionReport}}` — formatted from tool_use/tool_result events drained from `sessionHandle.drainEvents()` (see "Evaluate Inputs" design decision above)
   - `{{conditionCheck}}` — `SkillRegistry.isStepComplete()` (deterministic, advisory)
   - After evaluate returns, check for `result.diaryEntry` — if present, persist via read-append-write with `charFs.readDiary`/`charFs.writeDiary` (no append method exists)

f) Session spawn (step 7 in current code): adapt to use orient output for the initial task content instead of PromptBuilder.taskPrompt(). On first tick, force an orient+decide cycle regardless of observe disposition.

**What gets pushed to the session:**

Currently: `promptBuilder.channelEvent(...)` — a formatted text blob.

After: structured messages based on OODA output:
- On orient+decide(plan): push step instructions as work directives
- On orient+decide(continue): push orient headline as status context
- On orient+decide(wait): push wait acknowledgment
- On accumulate (no orient): push minimal heartbeat with emotional weight
- On evaluate(next_step): push next step instructions
- On evaluate(replan): push "replanning" notice, then new plan on next tick

### Step 6: Add dream as OODA loop step

**File:** `packages/core/src/core/orchestrator/channel-session.ts`

Dream runs as step 6 of the OODA loop, after evaluate and before sleep. It tracks two counters:

**New state variables:**
```typescript
let oodaCycleCount = 0    // incremented each time orient+decide completes
let lastDreamCycle = 0    // oodaCycleCount at last dream
let lastDreamTick = 0     // tickNumber at last dream
```

**`oodaCycleCount`** is incremented in step 4g, after orient+decide completes. Ticks where observe returns discard or accumulate (no orient+decide) don't increment it.

**Dream trigger:**
```typescript
if (config.dream) {
  const cycleInterval = config.dream.cycleInterval ?? 2
  const maxIntervalTicks = config.dream.maxIntervalTicks ?? 120
  const cyclesDue = oodaCycleCount - lastDreamCycle >= cycleInterval
  const timeDue = tickNumber - lastDreamTick >= maxIntervalTicks

  if (cyclesDue || timeDue) {
    const reason = cyclesDue
      ? `${oodaCycleCount - lastDreamCycle} OODA cycles since last dream`
      : `${tickNumber - lastDreamTick} ticks since last dream (ceiling)`
    yield* logToConsole(config.char.name, "orchestrator", `Dream — ${reason}`)
    yield* dream.execute({
      char: config.char,
      containerId: config.containerId,
      playerName: config.char.name,
      addDirs: config.addDirs,
      env: config.containerEnv,
      models: config.models ?? DEFAULT_MODEL_CONFIG,
    }).pipe(Effect.catchAll((e) =>
      logToConsole(config.char.name, "error", `Dream failed: ${e}`),
    ))
    lastDreamCycle = oodaCycleCount
    lastDreamTick = tickNumber
  }
}
```

This design ties memory consolidation to cognitive activity. An agent actively thinking (frequent orient+decide cycles) dreams more often. An idle agent waiting on external events still dreams eventually, but less frequently — the time ceiling is a safety net, not the primary driver.

Domains opt in by setting `config.dream`; omitting it disables the step entirely.

### Step 7: Wire domain configurations

**Files:** `packages/domain-github/src/phases.ts`, `packages/domain-spacemolt/src/phases.ts`

Update the `runChannelSession()` call in each domain's active phase to pass the new config fields:

```typescript
// GitHub — slow-paced, patient
yield* runChannelSession({
  ...existingConfig,
  cadence: "planned-action",
  models,
  dream: { cycleInterval: 3, maxIntervalTicks: 120 },  // every 3rd OODA cycle, or ~60 min ceiling
  orientInterval: 5,
})

// SpaceMolt — fast-paced, reactive
yield* runChannelSession({
  ...existingConfig,
  cadence: "real-time",
  models,
  dream: { cycleInterval: 2, maxIntervalTicks: 80 },   // every 2nd OODA cycle, or ~40 min ceiling
  orientInterval: 3,
})
```

SpaceMolt dreams every other OODA cycle with a 40-minute ceiling — it thinks fast, so it consolidates fast. GitHub dreams every 3rd cycle with a 60-minute ceiling — it's more deliberate, and fewer cycles complete per hour anyway.

### Step 8: Update PromptBuilder interface

**File:** `packages/core/src/core/prompt-builder.ts`

`channelEvent()` and `taskPrompt()` are no longer called by the tick loop — the OODA chain produces all session-push content. However, they should remain on the interface for backward compatibility during the transition. Mark them as optional in the interface:

```typescript
interface PromptBuilder {
  systemPrompt(mode: BrainMode, task: string): string
  /** @deprecated — OODA orient+decide now produces task content. Kept for fallback. */
  taskPrompt?(ctx: TaskPromptContext): string
  /** @deprecated — OODA orient produces channel event content. Kept for fallback. */
  channelEvent?(ctx: ChannelEventContext): string
}
```

The tick loop should fall back to `promptBuilder.channelEvent()` if the OODA chain fails (JSON parse error, LLM timeout), ensuring graceful degradation.

### Step 9: Update tests

**File:** `packages/core/src/skills/smoke.test.ts`

Update the observe test to use batch `events` variable instead of `eventType` + `eventPayload`.

**New file:** `packages/core/src/core/ooda-runner.test.ts`

Unit tests for:
- `extractJson()` — handles raw JSON, ```json fences, ```\njson, extra whitespace
- Skill rendering with realistic data (similar to existing smoke tests but through the OodaRunner API)
- Fallback behavior on malformed LLM output

### Step 10: Clean up stale code

After integration is confirmed working:

- Remove `PlanPromptContext`, `InterruptPromptContext`, `EvaluatePromptContext`, `SubagentPromptContext`, `PlannedActionBrainPromptContext` from `prompt-builder.ts` — these are remnants of the old brain/body architecture that nothing references at runtime
- Remove corresponding stale methods from domain PromptBuilder implementations
- Update HARNESS.md and DOMAIN_GUIDE.md to reflect the OODA integration

## Execution Order

Steps 1-3 are independent and can be parallelized. Steps 4-7 depend on step 3 (OodaRunner must exist). Step 8 can happen with step 5. Steps 9-10 come last.

```
[1] DomainBundle type fix ─────────────────────┐
[2] observe template batch format ─────────────┤
[3] OodaRunner module ─────────────────────────┤
                                                ├─> [5] Refactor tick loop
[4] ChannelSessionConfig fields ───────────────┤   [6] Dream cycle
                                                ├─> [7] Domain configs
                                                │   [8] PromptBuilder deprecation
                                                └─> [9] Tests
                                                    [10] Cleanup
```

## Risk Assessment

**Tick duration:** OODA LLM calls (observe + orient + decide) could push tick processing well past 30 seconds. Observe with haiku should be <5s. Orient+decide with opus could be 20-30s. Mitigation: the 30s sleep happens AFTER processing, so the effective tick interval is 30s + processing time. This is acceptable — the tick interval was never guaranteed to be exactly 30s.

**Cost:** Every tick with escalation triggers 3 LLM calls (observe + orient + decide). At 30s ticks, that's up to 120 LLM calls per hour. Most ticks should be observe-only (1 call) or skipped (0 calls, no events). Mitigation: observe uses fast tier (haiku), orient uses smart tier (sonnet). Only decide uses reasoning tier (opus), and only when orient actually ran.

**JSON parsing failures:** LLMs sometimes produce malformed JSON. Mitigation: extractJson() handles code fences, and each skill invocation falls back to a safe default on parse failure. The channelEvent() fallback ensures the session always gets something.

**Dream during active session:** Running dream.execute() mid-session pauses the tick loop for ~2 minutes (diary + secrets compression). The session continues running but won't receive state updates during this time. Mitigation: the session has enough context from previous pushes to continue working. Dream frequency is tied to OODA cycle count (default every 2nd cycle) with a time ceiling (default ~60 min), so it's driven by cognitive activity rather than wall clock. An agent in a quiet wait state won't dream often; an actively planning agent consolidates proportionally.
