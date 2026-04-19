# Agent Operating Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create four operating skill prompt templates (observe, orient, decide, evaluate) that replace the old brain-turn prompts and define the agent's decision loop for both real-time and planned-action cadences.

**Architecture:** Skill prompts live in `packages/core/src/skills/` as markdown templates with frontmatter. A loader reads and renders them. New types define the structured output each skill expects. The channel-session orchestrator passes observe/orient context to the session agent, which uses decide/evaluate internally.

**Tech Stack:** TypeScript, Effect, markdown templates with `{{mustache}}` variables, existing `parseFrontmatter`/`renderTemplate` utilities.

---

## File Structure

```
packages/core/src/skills/           # NEW directory
  observe.md                        # Observe skill prompt template
  orient.md                         # Orient skill prompt template
  decide.md                         # Decide skill prompt template
  evaluate.md                       # Evaluate skill prompt template
  types.ts                          # Output types: ObserveResult, OrientResult, DecideResult, EvaluateResult, WaitState
  loader.ts                         # loadSkill() utility — reads, parses frontmatter, renders template vars
  index.ts                          # Barrel: re-exports types and loader

packages/core/src/index.ts          # MODIFY: add re-exports for skill types and loader
```

### Task 1: Skill output types

**Files:**
- Create: `packages/core/src/skills/types.ts`

These types define the structured JSON output each skill prompt tells the LLM to produce.

- [ ] **Step 1: Write the types file**

```typescript
// packages/core/src/skills/types.ts

/**
 * Disposition — how observe classifies an incoming event.
 */
export type Disposition = "discard" | "accumulate" | "escalate"

/**
 * Result of the observe skill — event triage with emotional response.
 */
export interface ObserveResult {
  readonly disposition: Disposition
  /** Emoji string encoding gut reaction. Intensity = count, character = valence. */
  readonly emotionalWeight: string
  /** Brief note on why this disposition was chosen. */
  readonly reason: string
}

/**
 * Result of the orient skill — structured situation assessment.
 */
export interface OrientResult {
  readonly headline: string
  readonly sections: ReadonlyArray<{
    readonly id: string
    readonly heading: string
    readonly body: string
  }>
  readonly whatChanged: string
  /** Emotional state — carried forward from observe, potentially amplified. */
  readonly emotionalState: string
  readonly metrics: Record<string, string | number | boolean>
}

/**
 * What the agent is waiting for when it enters a wait state.
 */
export interface WaitState {
  /** Human-readable description of what we're waiting for. */
  readonly waitingFor: string
  /** What event would resolve the wait — observe uses this to know when to escalate. */
  readonly resolutionSignal: string
  /** Whether to hold the session open or terminate and resume next session. */
  readonly disposition: "hold" | "terminate"
}

/**
 * Result of the decide skill — what the agent chooses to do.
 */
export type DecideResult =
  | {
      readonly decision: "plan"
      readonly reasoning: string
      readonly steps: ReadonlyArray<{
        readonly task: string
        readonly goal: string
        readonly successCondition: string
        readonly tier: "fast" | "smart"
        readonly timeoutTicks: number
      }>
    }
  | { readonly decision: "continue"; readonly reasoning: string }
  | { readonly decision: "wait"; readonly reasoning: string; readonly wait: WaitState }
  | { readonly decision: "terminate"; readonly reasoning: string; readonly summary: string }

/**
 * Judgment on whether a step succeeded.
 */
export type Judgment = "succeeded" | "partially_succeeded" | "failed"

/**
 * Transition after evaluation — what happens next.
 */
export type EvaluateTransition =
  | { readonly transition: "next_step" }
  | { readonly transition: "replan"; readonly reason: string }
  | { readonly transition: "wait"; readonly wait: WaitState }
  | { readonly transition: "terminate"; readonly summary: string }

/**
 * Result of the evaluate skill — judgment plus transition.
 */
export interface EvaluateResult {
  readonly judgment: Judgment
  readonly reasoning: string
  readonly transition: EvaluateTransition
  /** Optional diary entry — evaluate is where the agent learns within a session. */
  readonly diaryEntry?: string
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd /Users/vcarl/workspace/roci/.claude/worktrees/finish-line && npx tsc --noEmit packages/core/src/skills/types.ts`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/skills/types.ts
git commit -m "feat: add operating skill output types (observe, orient, decide, evaluate)"
```

### Task 2: Skill loader utility

**Files:**
- Create: `packages/core/src/skills/loader.ts`
- Create: `packages/core/src/skills/index.ts`

The loader reads a skill markdown file, parses its frontmatter, and renders template variables. It builds on the existing `parseFrontmatter` and `renderTemplate` from `packages/core/src/core/template.ts`.

- [ ] **Step 1: Write the failing test**

Create: `packages/core/src/skills/loader.test.ts`

```typescript
import { describe, it, expect } from "vitest"
import { loadSkillSync, type LoadedSkill } from "./loader.js"
import * as path from "node:path"

const SKILLS_DIR = path.resolve(import.meta.dirname, ".")

describe("loadSkillSync", () => {
  it("loads a skill file and parses frontmatter", () => {
    // This will fail until observe.md exists, but validates the loader works
    const skill = loadSkillSync(path.join(SKILLS_DIR, "observe.md"))
    expect(skill.name).toBe("observe")
    expect(skill.description).toBeTruthy()
    expect(skill.template).toBeTruthy()
  })

  it("renders template variables", () => {
    const skill = loadSkillSync(path.join(SKILLS_DIR, "observe.md"))
    const rendered = skill.render({ cadence: "real-time", eventPayload: "test data" })
    expect(rendered).not.toContain("{{cadence}}")
    expect(rendered).toContain("real-time")
  })

  it("throws on missing file", () => {
    expect(() => loadSkillSync("/nonexistent/file.md")).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/vcarl/workspace/roci/.claude/worktrees/finish-line && npx vitest run packages/core/src/skills/loader.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the loader implementation**

```typescript
// packages/core/src/skills/loader.ts

import { readFileSync } from "node:fs"
import { parseFrontmatter, renderTemplate } from "../core/template.js"

/**
 * A loaded skill — parsed frontmatter metadata plus a render function
 * that fills in template variables.
 */
export interface LoadedSkill {
  readonly name: string
  readonly description: string
  readonly template: string
  /** Render the skill template with the given variables. */
  readonly render: (vars: Record<string, string>) => string
}

/**
 * Load a skill markdown file synchronously.
 * Parses frontmatter for metadata, returns the template body with a render function.
 */
export function loadSkillSync(filePath: string): LoadedSkill {
  const raw = readFileSync(filePath, "utf-8")
  const { meta, body } = parseFrontmatter(raw)
  const name = (meta.name as string) ?? ""
  const description = (meta.description as string) ?? ""
  return {
    name,
    description,
    template: body,
    render: (vars: Record<string, string>) => renderTemplate(body, vars),
  }
}
```

- [ ] **Step 4: Write the barrel file**

```typescript
// packages/core/src/skills/index.ts

export { loadSkillSync } from "./loader.js"
export type { LoadedSkill } from "./loader.js"

export type {
  Disposition,
  ObserveResult,
  OrientResult,
  WaitState,
  DecideResult,
  Judgment,
  EvaluateTransition,
  EvaluateResult,
} from "./types.js"
```

- [ ] **Step 5: Run the loader test (it will still fail — needs observe.md)**

Run: `cd /Users/vcarl/workspace/roci/.claude/worktrees/finish-line && npx vitest run packages/core/src/skills/loader.test.ts`
Expected: FAIL — observe.md not found (this is correct; we'll create it in Task 3)

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/skills/loader.ts packages/core/src/skills/index.ts packages/core/src/skills/loader.test.ts
git commit -m "feat: add skill loader utility and barrel file"
```

### Task 3: Write observe.md skill template

**Files:**
- Create: `packages/core/src/skills/observe.md`

Observe is the first filter — it runs in the limbic system (thalamus) and classifies incoming channel events into discard/accumulate/escalate with an emotional weight.

- [ ] **Step 1: Write the observe skill prompt**

```markdown
---
name: observe
description: Limbic event filter — classifies incoming events as discard/accumulate/escalate with emotional weight
---

# Observe

You are the sensory filter for an autonomous agent. Your job is to triage an incoming event — determine whether it matters and how urgently.

## Your Cadence: {{cadence}}

{{cadenceGuidance}}

## Incoming Event

Type: {{eventType}}

{{eventPayload}}

## Current Wait State

{{waitState}}

## Instructions

Evaluate this event and produce a JSON response:

1. **Disposition** — classify the event:
   - `discard` — nothing meaningful changed, no processing needed (e.g. a heartbeat tick with no state diff, redundant information)
   - `accumulate` — noteworthy but not urgent, fold into context for the next orientation pass (e.g. a new comment appeared, CI is still running, a resource level changed slightly)
   - `escalate` — requires immediate attention and reorientation (e.g. a critical alert, a waited-on event resolved, a task event arrived, something that invalidates current plans)

2. **Emotional weight** — express your gut reaction as an emoji string. Use emoji count for intensity and character for valence:
   - `👌` — routine, all fine
   - `😐` — neutral, nothing special
   - `💅` — mildly interesting
   - `💅💢` — annoying, needs attention
   - `😰😰` — worried
   - `🫠🫠😑🤬` — overwhelmed, multiple problems compounding
   - `🎉` — something good happened
   - Mix and match. Be expressive. This is your gut, not your analysis.

3. **Reason** — one sentence explaining the disposition choice.

If there is an active wait state, pay special attention to whether this event matches the resolution signal. If it does, escalate.

Respond with ONLY this JSON:
```json
{
  "disposition": "discard | accumulate | escalate",
  "emotionalWeight": "<emoji string>",
  "reason": "<one sentence>"
}
```
```

- [ ] **Step 2: Run the loader test**

Run: `cd /Users/vcarl/workspace/roci/.claude/worktrees/finish-line && npx vitest run packages/core/src/skills/loader.test.ts`
Expected: PASS — observe.md now exists, loader can parse it

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/skills/observe.md
git commit -m "feat: add observe skill prompt template"
```

### Task 4: Write orient.md skill template

**Files:**
- Create: `packages/core/src/skills/orient.md`

Orient synthesizes accumulated state into a curated situation assessment. It runs in the limbic system (thalamus + amygdala) and acts as an attention mechanism — deciding what context to surface to the conscious decision-maker.

- [ ] **Step 1: Write the orient skill prompt**

```markdown
---
name: orient
description: Limbic situation synthesis — curates context for the conscious decision-maker
---

# Orient

You are the situation synthesizer for an autonomous agent. Your job is to take accumulated observations and domain state, and produce a structured assessment that tells the decision-maker what's happening — without telling it what to do.

## Your Cadence: {{cadence}}

{{cadenceGuidance}}

## Accumulated Events Since Last Orientation

{{accumulatedEvents}}

## Current Domain State

{{domainState}}

## Agent Identity

### Background
{{background}}

### Values
{{values}}

### Recent Diary
{{diary}}

## Emotional Weight from Observations

{{emotionalWeight}}

## Instructions

Synthesize a situation assessment. You are an attention mechanism — your most important job is deciding what to include and what to leave out. The decision-maker should receive exactly the context it needs, no more.

Consider:
- What changed since the last orientation? Focus on meaningful deltas, not noise.
- Are there patterns across accumulated events that individually seemed minor but together paint a concerning (or encouraging) picture? If so, amplify the emotional state.
- What context from the agent's identity (background, values, diary) is relevant right now? Don't surface everything — surface what matters for the current situation.
- What metrics or quantitative signals would help the decision-maker calibrate?

You say "here is what's happening" — never "here is what you should do."

Respond with ONLY this JSON:
```json
{
  "headline": "<one-sentence summary of the current situation>",
  "sections": [
    {
      "id": "<stable-id>",
      "heading": "<section heading>",
      "body": "<relevant context, curated>"
    }
  ],
  "whatChanged": "<delta since last orientation>",
  "emotionalState": "<emoji string — carried forward from observations, potentially amplified>",
  "metrics": {
    "<key>": "<value>"
  }
}
```
```

- [ ] **Step 2: Verify the loader can parse it**

Run: `cd /Users/vcarl/workspace/roci/.claude/worktrees/finish-line && node -e "const { loadSkillSync } = require('./packages/core/dist/skills/loader.js'); const s = loadSkillSync('./packages/core/src/skills/orient.md'); console.log(s.name, s.description.slice(0, 50))"`

If this fails due to ESM/CJS issues, verify via the test instead:

Add to `packages/core/src/skills/loader.test.ts`:

```typescript
it("loads orient.md", () => {
  const skill = loadSkillSync(path.join(SKILLS_DIR, "orient.md"))
  expect(skill.name).toBe("orient")
  expect(skill.template).toContain("situation synthesizer")
})
```

Run: `cd /Users/vcarl/workspace/roci/.claude/worktrees/finish-line && npx vitest run packages/core/src/skills/loader.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/skills/orient.md packages/core/src/skills/loader.test.ts
git commit -m "feat: add orient skill prompt template"
```

### Task 5: Write decide.md skill template

**Files:**
- Create: `packages/core/src/skills/decide.md`

Decide is the first conscious step. It receives the orient situation assessment and chooses what to do: plan new work, continue current work, wait on something external, or terminate.

- [ ] **Step 1: Write the decide skill prompt**

```markdown
---
name: decide
description: Conscious decision-maker — receives situation assessment, chooses plan/continue/wait/terminate
---

# Decide

You are the decision-maker for an autonomous agent. You receive a curated situation assessment from your sensory system and choose what to do next.

## Your Cadence: {{cadence}}

{{cadenceGuidance}}

## Situation Assessment

### Headline
{{headline}}

### What Changed
{{whatChanged}}

### Emotional State
{{emotionalState}}

{{sections}}

### Metrics
{{metrics}}

## Current Plan State

{{currentPlanState}}

## Available Domain Skills

{{availableSkills}}

## Instructions

Based on the situation assessment, choose one of four actions:

### Plan
Create a new sequence of steps. Each step references a domain skill by name and includes a goal, success condition, model tier, and time budget.

- **tier: "fast"** — routine tasks, well-defined scope, deterministic outcomes
- **tier: "smart"** — tasks requiring judgment, ambiguity, complex reasoning

### Continue
Current work is still valid. Nothing in the situation assessment changes the plan. No action needed from you.

### Wait
You are blocked on something external. Specify exactly what you're waiting for, what event would resolve the wait (so the sensory system knows when to escalate), and whether to hold the session open or terminate and resume later.

### Terminate
Nothing actionable remains. The session should end. Provide a summary of what was accomplished.

Respond with ONLY one of these JSON shapes:

**Plan:**
```json
{
  "decision": "plan",
  "reasoning": "<why this plan>",
  "steps": [
    {
      "task": "<domain skill name>",
      "goal": "<what to accomplish>",
      "successCondition": "<how to verify completion>",
      "tier": "fast | smart",
      "timeoutTicks": <number>
    }
  ]
}
```

**Continue:**
```json
{
  "decision": "continue",
  "reasoning": "<why current work is still valid>"
}
```

**Wait:**
```json
{
  "decision": "wait",
  "reasoning": "<why we're blocked>",
  "wait": {
    "waitingFor": "<human-readable description>",
    "resolutionSignal": "<what observe should watch for>",
    "disposition": "hold | terminate"
  }
}
```

**Terminate:**
```json
{
  "decision": "terminate",
  "reasoning": "<why we're done>",
  "summary": "<what was accomplished>"
}
```
```

- [ ] **Step 2: Add test for decide.md loading**

Add to `packages/core/src/skills/loader.test.ts`:

```typescript
it("loads decide.md", () => {
  const skill = loadSkillSync(path.join(SKILLS_DIR, "decide.md"))
  expect(skill.name).toBe("decide")
  expect(skill.template).toContain("decision-maker")
})
```

Run: `cd /Users/vcarl/workspace/roci/.claude/worktrees/finish-line && npx vitest run packages/core/src/skills/loader.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/skills/decide.md packages/core/src/skills/loader.test.ts
git commit -m "feat: add decide skill prompt template"
```

### Task 6: Write evaluate.md skill template

**Files:**
- Create: `packages/core/src/skills/evaluate.md`

Evaluate judges the outcome of a domain skill execution and determines what happens next: advance to the next step, replan, wait, or terminate.

- [ ] **Step 1: Write the evaluate skill prompt**

```markdown
---
name: evaluate
description: Conscious evaluator — judges step outcomes, determines next transition
---

# Evaluate

You are evaluating whether a step in your plan was completed successfully. Based on the outcome, you determine what happens next.

## Your Cadence: {{cadence}}

{{cadenceGuidance}}

## The Step That Was Executed

**Task:** {{task}}
**Goal:** {{goal}}
**Success Condition:** {{successCondition}}
**Time Budget:** {{ticksBudgeted}} ticks (~{{secondsBudgeted}}s)
**Time Consumed:** {{ticksConsumed}} ticks (~{{secondsConsumed}}s)
{{overrunWarning}}

## Execution Result

{{executionReport}}

## State Changes (before → after)

{{stateDiff}}

## Deterministic Condition Check (advisory)

{{conditionCheck}}

## Current Emotional State

{{emotionalState}}

## Remaining Plan Steps

{{remainingSteps}}

## Instructions

1. **Judge** the outcome:
   - `succeeded` — the goal was met, success condition satisfied
   - `partially_succeeded` — meaningful progress was made but the goal isn't fully met
   - `failed` — the agent couldn't make progress, gave up, or did something unrelated

Be pragmatic. If reasonable progress was made toward the goal, lean toward `succeeded`. The deterministic condition check is advisory — use the execution report and state changes as primary evidence.

2. **Choose a transition:**
   - `next_step` — the plan continues, advance to the next step
   - `replan` — the result changed the situation enough that a fresh decision is needed (e.g. the fix exposed a deeper issue, an unexpected failure, the environment shifted)
   - `wait` — the step produced something that needs an external response (opened a PR, triggered CI, asked a question). Specify what you're waiting for and how you'll know it resolved.
   - `terminate` — the plan is complete (this was the last step and it succeeded), or no further progress is possible

3. **Optionally write a diary entry** — if you learned something meaningful during this step that's worth preserving across sessions, include it. Not every step warrants a diary entry. Use your judgment.

Respond with ONLY this JSON:
```json
{
  "judgment": "succeeded | partially_succeeded | failed",
  "reasoning": "<brief explanation, under 50 words>",
  "transition": {
    "transition": "next_step | replan | wait | terminate",
    // include if replan:
    "reason": "<why replanning is needed>",
    // include if wait:
    "wait": {
      "waitingFor": "<what we're waiting for>",
      "resolutionSignal": "<what observe should watch for>",
      "disposition": "hold | terminate"
    },
    // include if terminate:
    "summary": "<what was accomplished overall>"
  },
  "diaryEntry": "<optional — only if something meaningful was learned>"
}
```
```

- [ ] **Step 2: Add test for evaluate.md loading**

Add to `packages/core/src/skills/loader.test.ts`:

```typescript
it("loads evaluate.md", () => {
  const skill = loadSkillSync(path.join(SKILLS_DIR, "evaluate.md"))
  expect(skill.name).toBe("evaluate")
  expect(skill.template).toContain("evaluating")
})
```

Run: `cd /Users/vcarl/workspace/roci/.claude/worktrees/finish-line && npx vitest run packages/core/src/skills/loader.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/skills/evaluate.md packages/core/src/skills/loader.test.ts
git commit -m "feat: add evaluate skill prompt template"
```

### Task 7: Export skills from @roci/core

**Files:**
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Add re-exports for skill types and loader**

Add to the end of `packages/core/src/index.ts`:

```typescript
// Skills — operating loop prompt templates
export { loadSkillSync } from "./skills/index.js"
export type { LoadedSkill } from "./skills/index.js"
export type {
	Disposition,
	ObserveResult,
	OrientResult,
	WaitState,
	DecideResult,
	Judgment,
	EvaluateTransition,
	EvaluateResult,
} from "./skills/index.js"
```

- [ ] **Step 2: Verify the full package builds**

Run: `cd /Users/vcarl/workspace/roci/.claude/worktrees/finish-line && pnpm run build`
Expected: All 4 packages build successfully

- [ ] **Step 3: Run all skill tests**

Run: `cd /Users/vcarl/workspace/roci/.claude/worktrees/finish-line && npx vitest run packages/core/src/skills/`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat: export skill types and loader from @roci/core"
```

### Task 8: Add cadence guidance constants

**Files:**
- Create: `packages/core/src/skills/cadence.ts`

Each skill template has `{{cadenceGuidance}}` — this task provides the text that fills that variable for each cadence mode.

- [ ] **Step 1: Write the cadence guidance file**

```typescript
// packages/core/src/skills/cadence.ts

/**
 * Cadence-specific guidance text injected into skill templates via {{cadenceGuidance}}.
 * Each skill's behavior shifts based on cadence — these constants describe how.
 */

export type Cadence = "real-time" | "planned-action"

const OBSERVE_GUIDANCE: Record<Cadence, string> = {
  "real-time": `In real-time mode, your threshold for escalation is LOW. The environment changes fast — a missed event can mean missed opportunities or unrecovered threats. When in doubt between accumulate and escalate, prefer escalate. Discards should be reserved for truly empty heartbeats.`,
  "planned-action": `In planned-action mode, your threshold for escalation is HIGH. Most ticks should accumulate. The environment changes slowly — patience is a virtue. Only escalate for events that genuinely invalidate current work or resolve a wait state.`,
}

const ORIENT_GUIDANCE: Record<Cadence, string> = {
  "real-time": `In real-time mode, keep summaries tight and tactical. Focus on the immediate situation — what's happening right now and what changed in the last few ticks. The decision-maker needs fast reads, not comprehensive analyses.`,
  "planned-action": `In planned-action mode, summaries can be broader and more strategic. Include context about ongoing work, recent trends, and longer-term considerations. The decision-maker has time to think.`,
}

const DECIDE_GUIDANCE: Record<Cadence, string> = {
  "real-time": `In real-time mode, bias toward short plans (1-2 steps) and fast re-decision. The situation may shift before a long plan completes. If an escalated event arrives while executing, be willing to replan. Prefer action over deliberation.`,
  "planned-action": `In planned-action mode, you can plan 3-5 steps ahead. Wait states are expected and comfortable — it's fine to say "wait for CI" or "wait for review." Let current work finish before reorienting unless something truly urgent arrives.`,
}

const EVALUATE_GUIDANCE: Record<Cadence, string> = {
  "real-time": `In real-time mode, be more willing to replan. Partial success in a fast-moving environment often means the situation has shifted. Don't stubbornly continue a plan that's no longer relevant.`,
  "planned-action": `In planned-action mode, be more patient. Partial success on step 2 of 4 usually means continue the plan. Wait states are expected — opening a PR and waiting for review is normal workflow, not a failure.`,
}

const GUIDANCE_BY_SKILL: Record<string, Record<Cadence, string>> = {
  observe: OBSERVE_GUIDANCE,
  orient: ORIENT_GUIDANCE,
  decide: DECIDE_GUIDANCE,
  evaluate: EVALUATE_GUIDANCE,
}

/**
 * Get cadence guidance text for a given skill and cadence.
 */
export function getCadenceGuidance(skillName: string, cadence: Cadence): string {
  return GUIDANCE_BY_SKILL[skillName]?.[cadence] ?? ""
}
```

- [ ] **Step 2: Write a test for cadence guidance**

Add to `packages/core/src/skills/loader.test.ts`:

```typescript
import { getCadenceGuidance } from "./cadence.js"

describe("getCadenceGuidance", () => {
  it("returns guidance for observe + real-time", () => {
    const guidance = getCadenceGuidance("observe", "real-time")
    expect(guidance).toContain("LOW")
  })

  it("returns guidance for decide + planned-action", () => {
    const guidance = getCadenceGuidance("decide", "planned-action")
    expect(guidance).toContain("3-5 steps")
  })

  it("returns empty string for unknown skill", () => {
    expect(getCadenceGuidance("nonexistent", "real-time")).toBe("")
  })
})
```

Run: `cd /Users/vcarl/workspace/roci/.claude/worktrees/finish-line && npx vitest run packages/core/src/skills/loader.test.ts`
Expected: PASS

- [ ] **Step 3: Export cadence utilities from barrel**

Update `packages/core/src/skills/index.ts`:

```typescript
export { loadSkillSync } from "./loader.js"
export type { LoadedSkill } from "./loader.js"
export { getCadenceGuidance } from "./cadence.js"
export type { Cadence } from "./cadence.js"

export type {
  Disposition,
  ObserveResult,
  OrientResult,
  WaitState,
  DecideResult,
  Judgment,
  EvaluateTransition,
  EvaluateResult,
} from "./types.js"
```

Update `packages/core/src/index.ts` to add:

```typescript
export { getCadenceGuidance } from "./skills/index.js"
export type { Cadence } from "./skills/index.js"
```

- [ ] **Step 4: Verify build**

Run: `cd /Users/vcarl/workspace/roci/.claude/worktrees/finish-line && pnpm run build`
Expected: All packages build

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/skills/cadence.ts packages/core/src/skills/index.ts packages/core/src/skills/loader.test.ts packages/core/src/index.ts
git commit -m "feat: add cadence guidance constants for skill templates"
```

### Task 9: Ensure skill .md files are copied to dist

**Files:**
- Modify: `packages/core/scripts/copy-assets.js`

The skill `.md` files need to be included in the built package. The existing `copy-assets.js` script already handles this pattern for dream prompts.

- [ ] **Step 1: Read the current copy-assets script**

Read `packages/core/scripts/copy-assets.js` to understand the current pattern.

- [ ] **Step 2: Add skills directory to the copy list**

Add the `src/skills/*.md` → `dist/skills/*.md` copy alongside the existing patterns. Follow whatever pattern the script already uses (likely `fs.cpSync` or glob-based copy).

- [ ] **Step 3: Verify build copies skill files**

Run: `cd /Users/vcarl/workspace/roci/.claude/worktrees/finish-line && pnpm run build && ls packages/core/dist/skills/`
Expected: `observe.md`, `orient.md`, `decide.md`, `evaluate.md` appear in dist

- [ ] **Step 4: Commit**

```bash
git add packages/core/scripts/copy-assets.js
git commit -m "build: copy skill .md templates to dist"
```

### Task 10: Delete old brain-turn prompts

**Files:**
- Delete: `packages/domain-github/src/prompts/evaluate.md`
- Delete: `packages/domain-github/src/prompts/interrupt.md`
- Delete: `packages/domain-spacemolt/src/prompts/evaluate.md`
- Delete: `packages/domain-spacemolt/src/prompts/interrupt.md`
- Delete: `packages/domain-spacemolt/src/prompts/plan.md`

These are the old brain-turn prompts replaced by the new operating skills. Before deleting, verify nothing imports them.

- [ ] **Step 1: Check for imports of the old prompts**

Search for any code that references these files:

```bash
grep -r "prompts/evaluate\|prompts/interrupt\|prompts/plan" packages/ --include="*.ts" -l
```

If any files reference them, those references need to be updated or removed.

- [ ] **Step 2: Delete the old prompt files**

```bash
rm packages/domain-github/src/prompts/evaluate.md
rm packages/domain-github/src/prompts/interrupt.md
rm packages/domain-spacemolt/src/prompts/evaluate.md
rm packages/domain-spacemolt/src/prompts/interrupt.md
rm packages/domain-spacemolt/src/prompts/plan.md
```

- [ ] **Step 3: Verify build still passes**

Run: `cd /Users/vcarl/workspace/roci/.claude/worktrees/finish-line && pnpm run build`
Expected: All packages build (if imports were cleaned up in step 1)

- [ ] **Step 4: Commit**

```bash
git add -A packages/domain-github/src/prompts/ packages/domain-spacemolt/src/prompts/
git commit -m "refactor: delete old brain-turn prompts (replaced by operating skills)"
```

### Task 11: Run full test suite and verify

**Files:** None (verification only)

- [ ] **Step 1: Run all tests**

Run: `cd /Users/vcarl/workspace/roci/.claude/worktrees/finish-line && npx vitest run`
Expected: All tests pass

- [ ] **Step 2: Run full build**

Run: `cd /Users/vcarl/workspace/roci/.claude/worktrees/finish-line && pnpm run build`
Expected: Clean build, no errors

- [ ] **Step 3: Verify skill files are in dist**

Run: `ls packages/core/dist/skills/`
Expected: `observe.md`, `orient.md`, `decide.md`, `evaluate.md`, `types.js`, `loader.js`, `cadence.js`, `index.js` (plus `.d.ts` files)
