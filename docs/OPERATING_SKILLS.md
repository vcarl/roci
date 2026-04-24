# Operating Skills

Operating skills define how agents think at each stage of the decision loop. They implement an OODA (Observe-Orient-Decide-Act) cycle where each stage is a separate LLM invocation with a focused prompt.

## Overview

The skill system lives in `packages/core/src/skills/` and consists of four markdown templates, a type system, a loader, and a cadence guidance module.

```
Incoming Event
  |
  v
OBSERVE -- Triage: discard / accumulate / escalate (+ emotional weight)
  |
  [if escalate or enough accumulated]
  v
ORIENT -- Synthesize situation: headline, sections, metrics, emotional state
  |
  v
DECIDE -- Choose action: plan / continue / wait / terminate
  |
  [if plan]
  v
ACT -- Execute domain skill steps (code-change, pr-management, etc.)
  |
  v
EVALUATE -- Judge outcome: succeeded / partial / failed --> next_step / replan / wait / terminate
```

Each stage produces structured JSON that feeds into the next. The system is designed so that the "limbic" stages (observe, orient) are fast and cheap, while the "conscious" stages (decide, evaluate) use more capable models.

## Skill Templates

Templates are markdown files with YAML frontmatter. They use `{{variable}}` placeholders that are filled at render time by the orchestrator.

### Observe (`observe.md`)

The sensory filter. Classifies a single incoming event as:

- **discard** -- Nothing meaningful, skip processing (heartbeat with no diff, redundant info)
- **accumulate** -- Noteworthy but not urgent, fold into context for the next orientation
- **escalate** -- Requires immediate attention and reorientation

Also produces an **emotional weight** as an emoji string. Emoji count encodes intensity, character encodes valence: `👌` (routine), `💅💢` (annoyed), `😰😰` (worried), `🎉` (positive). This is a gut reaction, not analysis.

**Template variables:**

| Variable | Source |
|----------|--------|
| `cadence` | Domain config: `"real-time"` or `"planned-action"` |
| `cadenceGuidance` | Auto-injected from `cadence.ts` |
| `eventType` | Raw event type string |
| `eventPayload` | Serialized event content |
| `waitState` | Current wait state description, or "None" |

**Output type:** `ObserveResult` -- `{ disposition, emotionalWeight, reason }`

### Orient (`orient.md`)

The situation synthesizer. Takes accumulated observations and domain state and produces a structured assessment. Its job is to tell the decision-maker *what's happening* without telling it *what to do*.

Key responsibilities:
- Detect patterns across individually minor events
- Amplify or dampen emotional state based on patterns
- Surface relevant identity context (background, values, diary)
- Provide quantitative metrics for calibration

**Template variables:**

| Variable | Source |
|----------|--------|
| `cadence`, `cadenceGuidance` | Same as observe |
| `accumulatedEvents` | Events since last orientation |
| `domainState` | Current domain state snapshot |
| `background` | Agent's background identity |
| `values` | Agent's values |
| `diary` | Recent diary entries |
| `emotionalWeight` | Accumulated emotional weight from observations |

**Output type:** `OrientResult` -- `{ headline, sections[], whatChanged, emotionalState, metrics }`

### Decide (`decide.md`)

The conscious decision-maker. Receives the orient assessment and chooses one of four actions:

- **plan** -- Create a new sequence of steps. Each step references a domain skill by name and includes a goal, success condition, model tier (`fast` or `smart`), and tick budget.
- **continue** -- Current work is still valid, no action needed.
- **wait** -- Blocked on something external. Specifies what to wait for, what event would resolve it (so observe knows when to escalate), and whether to hold the session or terminate.
- **terminate** -- Nothing actionable remains. Session should end.

**Template variables:**

| Variable | Source |
|----------|--------|
| `cadence`, `cadenceGuidance` | Same as observe |
| `headline`, `whatChanged`, `emotionalState`, `sections`, `metrics` | From orient output |
| `currentPlanState` | Current plan (if any) |
| `availableSkills` | List of domain skills with descriptions |

**Output type:** `DecideResult` -- discriminated union on `decision` field

### Evaluate (`evaluate.md`)

The conscious evaluator. After a plan step executes, judges the outcome and determines what happens next.

Judgments:
- **succeeded** -- Goal met, success condition satisfied
- **partially_succeeded** -- Meaningful progress but goal not fully met
- **failed** -- No meaningful progress

Transitions:
- **next_step** -- Advance to the next plan step
- **replan** -- Situation changed enough to warrant a fresh decision
- **wait** -- Step produced something needing external response (opened PR, triggered CI)
- **terminate** -- Plan complete or no further progress possible

Can optionally produce a **diary entry** when something meaningful was learned.

**Template variables:**

| Variable | Source |
|----------|--------|
| `cadence`, `cadenceGuidance` | Same as observe |
| `task`, `goal`, `successCondition` | From the plan step |
| `ticksBudgeted`, `secondsBudgeted` | Time budget |
| `ticksConsumed`, `secondsConsumed` | Actual time used |
| `overrunWarning` | Warning text if over budget (empty string otherwise) |
| `executionReport` | What the step actually did |
| `stateDiff` | Before/after state changes |
| `conditionCheck` | Deterministic condition check result (advisory) |
| `emotionalState` | Current emotional state |
| `remainingSteps` | Remaining plan steps |

**Output type:** `EvaluateResult` -- `{ judgment, reasoning, transition, diaryEntry? }`

## Cadence System

Each domain operates at a cadence that shifts skill behavior. The two cadences are:

**Real-time** (e.g., SpaceMolt): Events arrive frequently, the environment changes fast.
- Observe: LOW escalation threshold -- when in doubt, escalate
- Orient: Tight, tactical summaries focused on immediate situation
- Decide: Bias toward short plans (1-2 steps), willing to replan
- Evaluate: More willing to replan on partial success

**Planned-action** (e.g., GitHub): Events arrive slowly, patience is a virtue.
- Observe: HIGH escalation threshold -- most ticks should accumulate
- Orient: Broader, more strategic summaries with longer-term context
- Decide: Can plan 3-5 steps ahead, wait states are comfortable
- Evaluate: More patient with partial success, let plans finish

Cadence guidance is injected into templates via `getCadenceGuidance(skillName, cadence)` from `cadence.ts`.

## Skill Loader

`loadSkillSync(filePath)` reads a skill markdown file, parses its YAML frontmatter, and returns a `LoadedSkill`:

```typescript
interface LoadedSkill {
  name: string          // from frontmatter
  description: string   // from frontmatter
  template: string      // body after frontmatter
  render: (vars: Record<string, string>) => string
}
```

The `render()` function replaces all `{{key}}` placeholders with values from the provided record. Unknown keys are replaced with empty string.

## How Skills Chain Together

Each skill's output feeds directly into the next stage:

```
observe output:
  emotionalWeight: "💅💢😰"  ─────────────> orient input: emotionalWeight
  disposition: "escalate"    ─────────────> triggers orientation

orient output:
  headline: "PR #247 needs..."  ──────────> decide input: headline
  sections: [...]               ──────────> decide input: sections
  whatChanged: "Review landed"  ──────────> decide input: whatChanged
  emotionalState: "💅💢😰😰"   ──────────> decide input: emotionalState
  metrics: { openPRs: 12 }     ──────────> decide input: metrics

decide output (plan):
  steps[0].task: "code-change"  ──────────> evaluate input: task
  steps[0].goal: "Fix race..."  ──────────> evaluate input: goal
  steps[0].successCondition     ──────────> evaluate input: successCondition
  steps[0].timeoutTicks: 4      ──────────> evaluate input: ticksBudgeted

evaluate output:
  transition: "next_step"       ──────────> advance to steps[1]
  transition: "replan"          ──────────> back to decide
  transition: "wait"            ──────────> observe watches for resolution
  diaryEntry: "..."             ──────────> written to character diary
```

The emotional weight carries through the entire chain. Observe produces a gut reaction, orient can amplify or dampen it based on patterns across multiple events, and the emotional state influences the decide stage's risk tolerance and urgency.

## Emotional Weight

The emoji-based emotional weight system is intentionally freeform. There is no enum of valid emotions -- the LLM picks emoji that express its assessment. Downstream stages (orient, decide) interpret the emoji as another LLM, which handles the semantics naturally.

Design principles:
- **Count = intensity**: `😰` is mild worry, `😰😰😰` is serious concern
- **Character = valence**: `🎉` is positive, `🤬` is negative, `😐` is neutral
- **Mixing = nuance**: `💅🎉` is "interesting and positive", `😰💢` is "worried and frustrated"
- **No parsing required**: the string passes through as context, never parsed programmatically

## Wait States

When decide or evaluate produces a `wait` transition, the result includes a `WaitState`:

```typescript
interface WaitState {
  waitingFor: string         // human-readable description
  resolutionSignal: string   // what observe should watch for to escalate
  disposition: "hold" | "terminate"  // keep session open or end and resume later
}
```

The `resolutionSignal` creates a feedback loop: observe reads it and knows to escalate when the waited-on event arrives, which triggers reorientation and a fresh decision.

## Types

All result types are exported from `@roci/core/skills`:

```typescript
import type {
  ObserveResult,
  OrientResult,
  DecideResult,
  EvaluateResult,
  WaitState,
  Disposition,    // "discard" | "accumulate" | "escalate"
  Judgment,       // "succeeded" | "partially_succeeded" | "failed"
  EvaluateTransition,
} from "@roci/core/skills"

import { loadSkillSync, getCadenceGuidance } from "@roci/core/skills"
import type { Cadence, LoadedSkill } from "@roci/core/skills"
```

## Rendering Example

```typescript
import { loadSkillSync, getCadenceGuidance } from "@roci/core/skills"
import type { Cadence } from "@roci/core/skills"
import * as path from "node:path"

const SKILLS_DIR = path.resolve(import.meta.dirname, "../skills")

function renderObserve(
  cadence: Cadence,
  eventType: string,
  eventPayload: string,
  waitState: string,
): string {
  const skill = loadSkillSync(path.join(SKILLS_DIR, "observe.md"))
  return skill.render({
    cadence,
    cadenceGuidance: getCadenceGuidance("observe", cadence),
    eventType,
    eventPayload,
    waitState,
  })
}

// Usage:
const prompt = renderObserve(
  "planned-action",
  "pull_request.review_submitted",
  JSON.stringify(reviewEvent),
  "None — not currently waiting.",
)
// `prompt` is now a complete prompt string ready for LLM invocation
```

## Integration Status

The skill templates are loadable and renderable but are not yet wired into the channel session tick loop. The current runtime uses `PromptBuilder.channelEvent()` to push state updates to the running session. Integrating operating skills will require building an adapter that:

1. Translates domain events and state into the template variable sets each skill expects
2. Invokes observe/orient/decide as separate LLM calls during the tick loop
3. Feeds decide's plan output into the session as structured work directives
4. Runs evaluate after each step completes
