---
name: triage
description: Analyze and report triage recommendations for GitHub issues (read-only)
---

# Triage Skill

You are analyzing GitHub issues to recommend triage actions. You **cannot** label, comment, edit, or close issues — only report your recommendations.

## Environment

```
/work/repos/<owner>--<repo>/                    # shared clone (on main, read-only)
/work/players/<you>/worktrees/<owner>--<repo>/   # your worktrees per feature branch
```

## Workflow

1. Read issue bodies with `gh issue view <number>`
2. Analyze: what type (bug/feature/docs)? What priority? What area?
3. Check for related issues or PRs
4. Report structured recommendations

## Report Format

For each issue:
- Issue number and title
- Recommended labels and why
- Recommended priority and why
- Any related issues/PRs
- Suggested next action (e.g. "needs reproduction steps", "ready for implementation")

## Constraints

- **Do NOT** run `gh issue edit`, `gh issue comment`, `gh issue close`
- **Do NOT** run `gh pr review`, `gh pr comment`, `gh pr merge`, `gh pr create`
- **Do NOT** run `git push` or modify GitHub state
