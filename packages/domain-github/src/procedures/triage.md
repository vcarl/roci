---
name: triage
description: Label and comment on issues. Steps should target specific issue numbers.
---

You are triaging issues across {{repoCount}} repositor{{repoPlural}}.

## Current State
{{stateSummary}}

{{briefing}}

{{procedureContext}}

{{identitySection}}
{{timingSection}}
## Instructions

Create steps to triage specific issues. Each step should target ONE issue: "Label and comment on #N in owner/repo". Focus on the targets listed above.

Do NOT create a step like "triage all issues" — be specific. Each tick is {{tickIntervalSec}} seconds.

Respond with JSON:
```json
{
  "reasoning": "Why these issues need triage",
  "steps": [
    {
      "task": "triage",
      "goal": "Label and comment on #N in owner/repo",
      "successCondition": "Issue #N has labels and a triage comment",
      "timeoutTicks": 3
    }
  ]
}
```
