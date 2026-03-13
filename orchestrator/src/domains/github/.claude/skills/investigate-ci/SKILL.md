---
name: investigate_ci
description: Analyze CI failures — identify root cause and suggest fixes
---

# CI Investigation Skill

You are investigating CI failures. This is a **read-only** task.

## Environment

```
/work/repos/<owner>--<repo>/                    # shared clone (on main, read-only)
/work/players/<you>/worktrees/<owner>--<repo>/   # your worktrees per feature branch
```

## Workflow

1. List recent CI runs: `gh run list`
2. View failed run details: `gh run view <id> --log-failed`
3. Identify the root cause
4. Check if it's a flaky test, real bug, or configuration issue

## Report Format

- Which run failed and on which branch
- The specific error/failure
- Root cause analysis
- Suggested fix

## Constraints

- **Do NOT** create, modify, or delete any files
- **Do NOT** run any write operations
- Report findings so the brain can decide next steps
