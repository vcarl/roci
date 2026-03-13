---
name: investigate
description: Read-only investigation of repository state — issues, PRs, CI status
---

# Investigation Skill

You are gathering information about repository state. This is a **read-only** task.

## Environment

```
/work/repos/<owner>--<repo>/                    # shared clone (on main, read-only)
/work/players/<you>/worktrees/<owner>--<repo>/   # your worktrees per feature branch
```

## Useful Commands

```bash
gh issue list
gh issue view <number>
gh pr list
gh pr view <number>
gh pr diff <number>
gh pr checks <number>
gh run list
gh run view <id>
gh run view <id> --log-failed
git log --oneline -20
git diff
```

## Constraints

- **Do NOT** create, modify, or delete any files
- **Do NOT** run any `gh` command that creates, edits, comments, reviews, or merges
- **Do NOT** run `git commit`, `git push`, or any write operation
- Report findings in a structured format so the brain can decide next steps
