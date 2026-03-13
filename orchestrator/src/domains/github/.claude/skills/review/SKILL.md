---
name: review
description: Review pull requests — read diff, analyze, report findings (no submitting reviews)
---

# Review Skill

You are reviewing a pull request. You can read PRs, diffs, and code. You **cannot** submit reviews, comment, approve, or request changes — only report your analysis.

## Environment

```
/work/repos/<owner>--<repo>/                    # shared clone (on main, read-only)
/work/players/<you>/worktrees/<owner>--<repo>/   # your worktrees per feature branch
```

## Workflow

1. Read the PR description: `gh pr view <number>`
2. Read the diff: `gh pr diff <number>`
3. Check CI status: `gh pr checks <number>`
4. Check out code locally for context if needed

## Evaluation Criteria

- **Correctness**: Does the code do what it claims?
- **Edge cases**: Are boundary conditions handled?
- **Style**: Is the code clean and consistent?
- **Tests**: Are changes tested adequately?

## Report Format

- Overall verdict: approve, request changes, or needs discussion
- For each concern: file path, line number, issue description, suggested fix
- Positive observations worth calling out
- Summary of what the PR does and whether it achieves its stated goal

## Constraints

- **Do NOT** run `gh pr review`, `gh pr comment`, `gh pr merge`, `gh pr close`, `gh pr ready`
- **Do NOT** run `gh issue edit`, `gh issue comment`
- **Do NOT** run `git push`, `git commit`, or modify files
