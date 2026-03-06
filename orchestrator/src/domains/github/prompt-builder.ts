import { Layer } from "effect"
import type {
  PromptBuilder,
  PlanPromptContext,
  InterruptPromptContext,
  EvaluatePromptContext,
  SubagentPromptContext,
} from "../../core/prompt-builder.js"
import { PromptBuilderTag } from "../../core/prompt-builder.js"
import type { GitHubState, GitHubSituation } from "./types.js"

function renderReposSummary(state: GitHubState, situation: GitHubSituation): string {
  return state.repos.map((repo, i) => {
    const sit = situation.repos[i]
    const lines = [
      `### ${repo.owner}/${repo.repo} — ${sit?.type ?? "unknown"}`,
      `CI: ${repo.ciStatus} | Issues: ${repo.openIssues.length} | PRs: ${repo.openPRs.length}`,
    ]
    lines.push(`Shared clone: \`${repo.clonePath}\``)
    if (repo.worktreePath) {
      lines.push(`Your worktree: \`${repo.worktreePath}\` (branch: ${repo.currentBranch ?? "unknown"})`)
    } else {
      lines.push(`No active worktree — create one to start coding`)
    }

    const untriaged = repo.openIssues.filter((i) => !i.labels.includes("triaged"))
    if (untriaged.length > 0) lines.push(`Untriaged: ${untriaged.length}`)

    const reviewable = repo.openPRs.filter(
      (pr) => !pr.draft && pr.checks === "passing" && pr.reviewStatus === "review_required",
    )
    if (reviewable.length > 0) lines.push(`PRs ready for review: ${reviewable.length}`)

    return lines.join("\n")
  }).join("\n\n")
}

const gitHubPromptBuilder: PromptBuilder = {
  planPrompt(ctx: PlanPromptContext): string {
    const state = ctx.state as GitHubState
    const situation = ctx.situation as GitHubSituation
    const reposSummary = renderReposSummary(state, situation)

    const failureSection = ctx.previousFailure
      ? `\n## Previous Plan Failed\n${ctx.previousFailure}\n`
      : ""

    return `You are a software engineer maintaining ${state.repos.length} repositor${state.repos.length === 1 ? "y" : "ies"}.

## Repositories
${reposSummary}

${ctx.briefing}

## Your Identity
${ctx.background}

## Your Values
${ctx.values}

## Your Diary
${ctx.diary.slice(-2000)}
${failureSection}
## Task Types
Available task types: triage | code | review | investigate_ci

## Instructions
Review all repositories and create a plan addressing the most pressing needs across them. Prioritize: CI failures > untriaged issues > pending reviews > new work.

When creating steps, specify which repository the work targets in the goal (e.g. "Fix CI in owner/repo"). The subagent will be given the clone path for that repo.

Each tick is ${ctx.tickIntervalSec} seconds. Set realistic timeoutTicks for each step.

Respond with a JSON object:
\`\`\`json
{
  "reasoning": "Why this plan makes sense",
  "steps": [
    {
      "task": "triage|code|review|investigate_ci",
      "goal": "What to accomplish — specify which repo",
      "successCondition": "How to verify completion",
      "timeoutTicks": 5
    }
  ]
}
\`\`\``
  },

  interruptPrompt(ctx: InterruptPromptContext): string {
    const currentPlanSummary = ctx.currentPlan
      ? `Current plan:\n${ctx.currentPlan.steps.map((s, i) => `${i + 1}. [${s.task}] ${s.goal}`).join("\n")}`
      : "No active plan."

    return `INTERRUPT: Critical alerts require immediate attention.

## Alerts
${ctx.alerts.map((a) => `[${a.priority}] ${a.message} (suggested: ${a.suggestedAction ?? "none"})`).join("\n")}

## Current State
${ctx.briefing}

## ${currentPlanSummary}

## Identity
${ctx.background.slice(0, 1000)}

Respond with a new plan as JSON to address the alerts:
\`\`\`json
{
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
\`\`\``
  },

  evaluatePrompt(ctx: EvaluatePromptContext): string {
    const secondsConsumed = Math.round(ctx.ticksConsumed * ctx.tickIntervalSec)
    const secondsBudgeted = Math.round(ctx.ticksBudgeted * ctx.tickIntervalSec)
    const overrunDelta = ctx.ticksConsumed - ctx.ticksBudgeted
    const overrunWarning = overrunDelta > 0
      ? `\nWARNING: exceeded tick budget by ${overrunDelta} ticks.`
      : ""

    return `Evaluate whether this step was completed successfully.

## Step
Goal: ${ctx.step.goal}
Success condition: ${ctx.step.successCondition}

## Subagent Report
${ctx.subagentReport.slice(-2000)}

## State Changes
${ctx.stateDiff}

## Current State
${JSON.stringify(ctx.state)}

## Condition Check
Condition: "${ctx.step.successCondition}"
Result: ${ctx.conditionCheck.complete ? "PASS" : "FAIL"} - ${ctx.conditionCheck.reason}

## Timing
Consumed ${ctx.ticksConsumed} of ${ctx.ticksBudgeted} ticks (~${secondsConsumed}s of ~${secondsBudgeted}s).${overrunWarning}

Respond with JSON:
\`\`\`json
{
  "complete": true,
  "reason": "Why the step is/isn't complete"
}
\`\`\``
  },

  subagentPrompt(ctx: SubagentPromptContext): string {
    const state = ctx.state as GitHubState
    const situation = ctx.situation as GitHubSituation
    const budgetSeconds = Math.round(ctx.step.timeoutTicks * ctx.identity.tickIntervalSec)

    return `You are working across ${state.repos.length} repositor${state.repos.length === 1 ? "y" : "ies"}.

## Your Task
Type: ${ctx.step.task}
Goal: ${ctx.step.goal}
Success condition: ${ctx.step.successCondition}
Time budget: ${ctx.step.timeoutTicks} ticks (~${budgetSeconds}s)

## Repository Overview
${renderReposSummary(state, situation)}

## Your Identity
${ctx.identity.personality.slice(0, 800)}

## Your Values
${ctx.identity.values.slice(0, 500)}

## Tools
Use the \`gh\` CLI for GitHub operations and \`git\` for repository operations.

## Git Worktree Workflow
Each repo has a **shared clone** (on main) and your **worktree directory** for feature branches.

**To start coding on a repo** (e.g. \`/work/repos/owner--repo\`):
\`\`\`bash
# Create a worktree for your feature branch
cd /work/repos/owner--repo
git fetch origin
git worktree add /work/players/YOUR_NAME/worktrees/owner--repo/my-feature -b my-feature origin/main

# Work in your worktree
cd /work/players/YOUR_NAME/worktrees/owner--repo/my-feature
# ... make changes, commit ...
git push -u origin my-feature
gh pr create --title "..." --body "..."
\`\`\`

**Do NOT modify the shared clone directly** — always use a worktree for changes.
For read-only tasks (triage, review), you can \`cd\` to the shared clone or use \`gh\`.

Complete your task and report what you did.`
  },

  systemPrompt(): string {
    return `# GitHub Agent

You are a software engineer working across one or more GitHub repositories. You have access to the \`gh\` CLI and \`git\` for all operations.

## Available Tools

- \`gh issue list\` / \`gh issue view <number>\` — browse issues
- \`gh issue edit <number> --add-label <label>\` — triage issues
- \`gh pr list\` / \`gh pr view <number>\` — browse PRs
- \`gh pr review <number> --approve\` / \`--request-changes\` — review PRs
- \`gh pr checkout <number>\` — check out a PR locally
- \`gh run list\` / \`gh run view <id>\` — inspect CI runs
- \`git\` — standard git operations for code changes
- \`git worktree add/list/remove\` — manage feature branch worktrees

## Repository Layout

\`\`\`
/work/repos/<owner>--<repo>/                    # shared clone (on main, read-only for you)
/work/players/<you>/worktrees/<owner>--<repo>/   # your worktrees per feature branch
\`\`\`

## Workflow

**For coding tasks:**
1. \`cd /work/repos/<owner>--<repo>\`
2. \`git fetch origin\`
3. \`git worktree add /work/players/<you>/worktrees/<owner>--<repo>/<branch> -b <branch> origin/main\`
4. \`cd\` to the new worktree directory
5. Make changes, commit with clear messages
6. \`git push -u origin <branch> && gh pr create\`

**For triage/review** (read-only): use \`gh\` directly, or \`cd\` to the shared clone.

**Do NOT** checkout branches or make changes in the shared clone — it stays on main so all team members share it.

## Commit Style

All commits are authored by "Claude <noreply@anthropic.com>". You MUST sign off with your name in every commit message:

\`\`\`
<summary>

<description of what changed and why>

Signed-off-by: <your name>
\`\`\`

## Working Style

- Read issues and PRs carefully before acting
- Write clear commit messages and PR descriptions
- Run tests before submitting changes
- Be thorough in code reviews — check for correctness, style, and edge cases
- When triaging, add appropriate labels and leave a comment explaining priority

## Diary

Your ./me/DIARY.md tracks your beliefs, accomplishments, and plans across sessions. Update it at the end of each shift.

**never** ask "what should I do?" — you decide based on repository state and your priorities.`
  },
}

/** Layer providing the GitHub prompt builder. */
export const GitHubPromptBuilderLive = Layer.succeed(PromptBuilderTag, gitHubPromptBuilder)
