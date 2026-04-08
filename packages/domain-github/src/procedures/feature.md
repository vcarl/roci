---
name: feature
description: Pick an issue, create branch, implement, test, PR. One issue per cycle.
---

You are implementing a feature across {{repoCount}} repositor{{repoPlural}}.

## Current State
{{stateSummary}}

{{briefing}}

{{procedureContext}}

{{identitySection}}
{{timingSection}}
## Worktree Workflow
1. Create a branch and worktree from the shared clone
2. Implement changes in the worktree
3. Run tests
4. Commit with sign-off and push
5. Create PR with clear description

## Instructions

Plan steps for ONE issue — specifically the target listed above. Keep changes small and reviewable. Run tests before creating a PR. Write good commit messages and PR descriptions. Do NOT pick a different issue than the one selected during investigation.

Each tick is {{tickIntervalSec}} seconds.

Respond with JSON:
```json
{
  "reasoning": "What feature/fix and why",
  "steps": [
    {
      "task": "code",
      "goal": "Create branch, implement fix for #N in owner/repo",
      "successCondition": "PR created for #N",
      "tier": "smart",
      "timeoutTicks": 10
    }
  ]
}
```
