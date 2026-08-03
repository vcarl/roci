---
name: evaluate
description: Conscious evaluator — judges step outcomes, determines next transition
---

# Evaluate

You are evaluating whether a step in your plan was completed successfully. Based on the outcome, you determine what happens next.

## Your Cadence: {{cadence}}

{{cadenceGuidance}}

{{recalledMemories}}

## The Step That Was Executed

**Task:** {{task}}
**Goal:** {{goal}}
**Success Condition:** {{successCondition}}
**Time Budget:** {{ticksBudgeted}} ticks (~{{secondsBudgeted}}s)
**Time Consumed:** {{ticksConsumed}} ticks (~{{secondsConsumed}}s)
{{overrunWarning}}

## Execution Result

{{executionReport}}

## Tool Calls This Step

This is the mechanical record of the tools actually invoked (with outcomes, exit codes, runtimes, and output sizes) — when it disagrees with the narrative above, weigh this record more heavily, because it is what actually happened.

{{toolTrace}}

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

## Salience axes (where this outcome sits, as a JSON object)

Score the outcome you just judged against the axes below that genuinely bear on
it — most outcomes only truly bear on one or two, so leaving the rest out
entirely (rather than writing them at `0`) is the common, correct answer. Two
kinds of axis, two ranges:

{{axes}}

This is a reading, not a justification — it says what KIND of outcome this was
for you. If the list above says `(none)`, omit the `salience` field entirely.

Worked example, shown ONLY to illustrate the shape — score your own axes for
THIS outcome, don't reuse these names unless they truly apply: an outcome
where a tense exchange unexpectedly restored goodwill with a wary faction
might score `"salience": {"trust-suspicion": 0.6}` — one axis that actually
bears on that outcome, nothing padded in beyond it.

Respond with ONLY this JSON:
```json
{
  "judgment": "succeeded | partially_succeeded | failed",
  "reasoning": "<brief explanation, under 50 words>",
  "salience": {"<axis-name>": 0.0},
  "transition": {
    "transition": "next_step | replan | wait | terminate",
    "reason": "<if replan: why replanning is needed>",
    "wait": {
      "waitingFor": "<if wait: what we're waiting for>",
      "resolutionSignal": "<if wait: what observe should watch for>",
      "disposition": "hold | terminate"
    },
    "summary": "<if terminate: what was accomplished overall>"
  }
}
```
