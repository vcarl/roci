---
name: interrupt
description: Handle critical alerts that require immediate replanning
---

INTERRUPT: Critical alerts require immediate attention.

## Alerts
{{alertLines}}
{{modeContext}}
## Current State
{{briefing}}

## {{currentPlanSummary}}

## Identity
{{background}}

Respond with a new plan as JSON. Pick a procedure for the response if appropriate.

```json
{
  "procedure": "triage|feature|review",
  "targets": ["#N"],
  "reasoning": "Why this plan addresses the alerts",
  "steps": [
    {
      "task": "investigate_ci|triage|code|review",
      "goal": "What to accomplish — specify which repo",
      "successCondition": "How to verify",
      "timeoutTicks": 5
    }
  ]
}
```
