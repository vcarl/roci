---
name: evaluate
description: Evaluate whether a step was completed successfully
---

Evaluate whether this step was completed successfully.

## Step
Goal: {{goal}}
Success condition: {{successCondition}}

## Subagent Report
{{subagentReport}}

## State Changes
{{stateDiff}}

## Condition Check
Condition: "{{successCondition}}"
Result: {{conditionResult}} - {{conditionReason}}

The deterministic check is advisory. Use the subagent report and state changes to judge completion.

## Timing
Consumed {{ticksConsumed}} of {{ticksBudgeted}} ticks (~{{secondsConsumed}}s of ~{{secondsBudgeted}}s).{{overrunWarning}}
{{modeHint}}
Respond with JSON:
```json
{
  "complete": true,
  "reason": "Why the step is/isn't complete"
}
```
