---
name: code
description: Implement code changes using git worktrees — local commits only, no push
---

# Code Skill

You are implementing code changes locally. You can read GitHub data, write code, and commit locally. You **cannot** push or create PRs.

## Environment

```
/work/repos/<owner>--<repo>/                    # shared clone (on main, read-only)
/work/players/<you>/worktrees/<owner>--<repo>/   # your worktrees per feature branch
```

## Worktree Workflow

```bash
# 1. Fetch latest from the shared clone
cd /work/repos/owner--repo
git fetch origin

# 2. Create a worktree for your feature branch
git worktree add /work/players/YOUR_NAME/worktrees/owner--repo/my-feature -b my-feature origin/main

# 3. Work in the worktree
cd /work/players/YOUR_NAME/worktrees/owner--repo/my-feature
# ... make changes, run tests, commit ...
```

**Do NOT modify the shared clone directly** — always use a worktree.

## Commit Style

All commits are authored by "Claude <noreply@anthropic.com>". Sign off with your character name:

```
<summary>

<description>

Signed-off-by: <your name>
```

## Constraints

- **Do NOT** run `git push` (any form)
- **Do NOT** run `gh pr create`, `gh pr comment`, `gh pr review`, `gh pr merge`
- **Do NOT** run `gh issue edit`, `gh issue comment`
- Report the branch name and worktree path — the brain handles publishing
