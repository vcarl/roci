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
import type { BrainMode } from "../../core/types.js"

// ── Shared helpers ──────────────────────────────────────────

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

function renderStateSummary(state: GitHubState, situation: GitHubSituation): string {
  return state.repos.map((repo, i) => {
    const sit = situation.repos[i]
    const lines = [
      `## ${repo.owner}/${repo.repo} — ${sit?.type ?? "unknown"}`,
      `CI: ${repo.ciStatus} | Issues: ${repo.openIssues.length} | PRs: ${repo.openPRs.length}`,
    ]

    if (repo.openIssues.length > 0) {
      lines.push("Issues:")
      for (const issue of repo.openIssues) {
        const labels = issue.labels.length > 0 ? ` [${issue.labels.join(", ")}]` : ""
        lines.push(`  #${issue.number}: ${issue.title}${labels}`)
      }
    }

    if (repo.openPRs.length > 0) {
      lines.push("PRs:")
      for (const pr of repo.openPRs) {
        const status = pr.draft ? "draft" : `checks:${pr.checks} review:${pr.reviewStatus}`
        lines.push(`  #${pr.number}: ${pr.title} (${status})`)
      }
    }

    return lines.join("\n")
  }).join("\n\n")
}

function buildTimingSection(ctx: PlanPromptContext): string {
  if (!ctx.stepTimingHistory || ctx.stepTimingHistory.length === 0) return ""
  return `\n## Recent Step Outcomes\n${ctx.stepTimingHistory.map((h) => {
    let line = `[${h.task}] "${h.goal}" — ${h.ticksConsumed}/${h.ticksBudgeted} ticks${h.overrun ? " OVERRUN" : ""}`
    if (h.succeeded !== undefined) {
      line += ` -> ${h.succeeded ? "SUCCESS" : "FAILED"}`
      if (h.reason) line += `: ${h.reason}`
    }
    return line
  }).join("\n")}\n\nUse this data to set realistic timeoutTicks.\n`
}

function renderIdentitySection(ctx: { background: string; values: string }): string {
  return `## Your Identity
${ctx.background}

## Your Values
${ctx.values}`
}

function renderProcedureContext(ctx: PlanPromptContext): string {
  const sections: string[] = []
  if (ctx.procedureTargets && ctx.procedureTargets.length > 0) {
    sections.push(`## Procedure Targets\nYou are focused on: ${ctx.procedureTargets.join(", ")}`)
  }
  if (ctx.investigationReport) {
    sections.push(`## Investigation Findings\n${ctx.investigationReport.slice(-2000)}`)
  }
  return sections.join("\n\n")
}

// ── Plan prompts by mode ────────────────────────────────────

function planPromptSelect(ctx: PlanPromptContext): string {
  const state = ctx.state as GitHubState
  const situation = ctx.situation as GitHubSituation
  const stateSummary = renderStateSummary(state, situation)
  const failureSection = ctx.previousFailure
    ? `\n## Previous Plan Failed\n${ctx.previousFailure}\n`
    : ""

  if (!ctx.investigationReport) {
    // No investigation yet — produce a 1-step investigation plan
    return `You are a software engineer maintaining ${state.repos.length} repositor${state.repos.length === 1 ? "y" : "ies"}.

## Current State
${stateSummary}

${ctx.briefing}

${renderIdentitySection(ctx)}

## Your Diary
${ctx.diary.slice(-2000)}
${failureSection}
## Instructions

You need to investigate before committing to a plan. Produce a 1-step plan with task "investigate" that gathers the context you need to decide what to do next.

The investigation goal should describe what to look into — e.g. "Read bodies of issues #12, #15, #18 and check CI status for repo X". Be specific about what information you need.

Each tick is ${ctx.tickIntervalSec} seconds.
${buildTimingSection(ctx)}
Respond with JSON:
\`\`\`json
{
  "reasoning": "What you need to investigate and why",
  "steps": [
    {
      "task": "investigate",
      "goal": "Specific things to read/check",
      "successCondition": "Investigation findings reported",
      "timeoutTicks": 5
    }
  ]
}
\`\`\``
  }

  // Have investigation report — MUST pick a procedure
  return `You are a software engineer maintaining ${state.repos.length} repositor${state.repos.length === 1 ? "y" : "ies"}.

## Current State
${stateSummary}

${ctx.briefing}

## Investigation Report
${ctx.investigationReport.slice(-3000)}

${renderIdentitySection(ctx)}

## Your Diary
${ctx.diary.slice(-2000)}
${failureSection}
## Available Procedures

- **triage**: Label and comment on issues. Steps should target specific issue numbers.
- **feature**: Pick an issue, create branch, implement, test, PR. One issue per cycle.
- **review**: Review a specific PR. Read diff, check correctness, submit feedback.

## Instructions

You MUST pick a procedure now. Do NOT produce another "investigate" step — investigation is complete. The "procedure" field is REQUIRED.

Based on your investigation, pick ONE procedure. Scope to specific items. Prefer focused over broad.

Prioritize: CI failures > untriaged issues > pending reviews > new work.

Each tick is ${ctx.tickIntervalSec} seconds.
${buildTimingSection(ctx)}
Respond with JSON (the "procedure" field is REQUIRED):
\`\`\`json
{
  "procedure": "triage|feature|review",
  "targets": ["#12", "#15"],
  "reasoning": "Why this procedure and these targets",
  "steps": [
    {
      "task": "triage|code|review|investigate_ci",
      "goal": "Specific action on specific item — e.g. 'Label and comment on #12'",
      "successCondition": "How to verify completion",
      "timeoutTicks": 5
    }
  ]
}
\`\`\``
}

function planPromptTriage(ctx: PlanPromptContext): string {
  const state = ctx.state as GitHubState
  const situation = ctx.situation as GitHubSituation

  return `You are triaging issues across ${state.repos.length} repositor${state.repos.length === 1 ? "y" : "ies"}.

## Current State
${renderStateSummary(state, situation)}

${ctx.briefing}

${renderProcedureContext(ctx)}

${renderIdentitySection(ctx)}
${buildTimingSection(ctx)}
## Instructions

Create steps to triage specific issues. Each step should target ONE issue: "Label and comment on #N in owner/repo". Focus on the targets listed above.

Do NOT create a step like "triage all issues" — be specific. Each tick is ${ctx.tickIntervalSec} seconds.

Respond with JSON:
\`\`\`json
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
\`\`\``
}

function planPromptFeature(ctx: PlanPromptContext): string {
  const state = ctx.state as GitHubState
  const situation = ctx.situation as GitHubSituation

  return `You are implementing a feature across ${state.repos.length} repositor${state.repos.length === 1 ? "y" : "ies"}.

## Current State
${renderStateSummary(state, situation)}

${ctx.briefing}

${renderProcedureContext(ctx)}

${renderIdentitySection(ctx)}
${buildTimingSection(ctx)}
## Worktree Workflow
1. Create a branch and worktree from the shared clone
2. Implement changes in the worktree
3. Run tests
4. Commit with sign-off and push
5. Create PR with clear description

## Instructions

Plan steps for ONE issue — specifically the target listed above. Keep changes small and reviewable. Run tests before creating a PR. Write good commit messages and PR descriptions. Do NOT pick a different issue than the one selected during investigation.

Each tick is ${ctx.tickIntervalSec} seconds.

Respond with JSON:
\`\`\`json
{
  "reasoning": "What feature/fix and why",
  "steps": [
    {
      "task": "code",
      "goal": "Create branch, implement fix for #N in owner/repo",
      "successCondition": "PR created for #N",
      "model": "sonnet",
      "timeoutTicks": 10
    }
  ]
}
\`\`\``
}

function planPromptReview(ctx: PlanPromptContext): string {
  const state = ctx.state as GitHubState
  const situation = ctx.situation as GitHubSituation

  return `You are reviewing pull requests across ${state.repos.length} repositor${state.repos.length === 1 ? "y" : "ies"}.

## Current State
${renderStateSummary(state, situation)}

${ctx.briefing}

${renderProcedureContext(ctx)}

${renderIdentitySection(ctx)}
${buildTimingSection(ctx)}
## Review Workflow
1. Read the PR description and diff carefully
2. Check for correctness, style, and edge cases
3. Submit review with constructive, specific feedback

## Instructions

Plan steps to review specific PRs. Each step should target ONE PR.

Each tick is ${ctx.tickIntervalSec} seconds.

Respond with JSON:
\`\`\`json
{
  "reasoning": "Which PRs to review and why",
  "steps": [
    {
      "task": "review",
      "goal": "Review PR #N in owner/repo",
      "successCondition": "Review submitted for PR #N",
      "timeoutTicks": 5
    }
  ]
}
\`\`\``
}

const PLAN_PROMPT_BY_MODE: Record<BrainMode, (ctx: PlanPromptContext) => string> = {
  select: planPromptSelect,
  triage: planPromptTriage,
  feature: planPromptFeature,
  review: planPromptReview,
}

// ── Subagent prompts by task type ───────────────────────────

function subagentCommon(ctx: SubagentPromptContext): string {
  const state = ctx.state as GitHubState
  const situation = ctx.situation as GitHubSituation
  const budgetSeconds = Math.round(ctx.step.timeoutTicks * ctx.identity.tickIntervalSec)

  return `## Your Task
Type: ${ctx.step.task}
Goal: ${ctx.step.goal}
Success condition: ${ctx.step.successCondition}
Time budget: ${ctx.step.timeoutTicks} ticks (~${budgetSeconds}s)

## Repository Overview
${renderReposSummary(state, situation)}

## Your Identity
${ctx.identity.personality.slice(0, 800)}

## Your Values
${ctx.identity.values.slice(0, 500)}`
}

function subagentInvestigate(ctx: SubagentPromptContext): string {
  return `You are investigating repository state. This is a **READ-ONLY** task.

${subagentCommon(ctx)}

## CRITICAL CONSTRAINTS

You are ONLY allowed to READ. You must NOT:
- Run \`gh issue edit\`, \`gh issue comment\`, \`gh issue close\`, or any issue-modifying command
- Run \`gh pr review\`, \`gh pr comment\`, \`gh pr merge\`, \`gh pr close\`, or any PR-modifying command
- Run \`git commit\`, \`git push\`, or any write operation
- Create, modify, or delete any files
- Spawn subagents that perform write operations

If you use a prohibited command, the task is a FAILURE.

## Allowed Commands

- \`gh issue view <number>\` — read issue details
- \`gh issue list\` — list issues
- \`gh pr view <number>\` — read PR details
- \`gh pr diff <number>\` — read PR diffs
- \`gh pr list\` — list PRs
- \`gh run list\` / \`gh run view <id>\` / \`gh run view <id> --log-failed\` — read CI status
- \`cat\`, \`ls\`, \`find\`, \`grep\` — read files in the repo

## Instructions

Gather information and report back. Your report will be used by the planning brain to decide what to do next. Do NOT take action — just report what you find.

Report your findings in a structured format:
- For each issue: number, title, key details from the body, suggested priority/labels
- For each PR: number, title, diff summary, test status, review readiness
- For CI: failure details, root cause if identifiable

Be thorough but focused on what was requested in the goal.`
}

function subagentTriage(ctx: SubagentPromptContext): string {
  return `You are triaging GitHub issues.

${subagentCommon(ctx)}

## Instructions

For each issue in your goal:
1. Read the issue body carefully with \`gh issue view <number>\`
2. Add appropriate labels with \`gh issue edit <number> --add-label <label>\`
3. Leave a comment explaining your triage decision with \`gh issue comment <number> --body "..."\`

Be specific about why each label was chosen. Consider priority, type (bug/feature/docs), and area.

Report what labels you added and why for each issue.`
}

function subagentCode(ctx: SubagentPromptContext): string {
  const state = ctx.state as GitHubState

  return `You are implementing code changes.

${subagentCommon(ctx)}

## Git Worktree Workflow

Each repo has a **shared clone** (on main) and your **worktree directory** for feature branches.

**To start coding on a repo** (e.g. \`/work/repos/owner--repo\`):
\`\`\`bash
cd /work/repos/owner--repo
git fetch origin
git worktree add /work/players/YOUR_NAME/worktrees/owner--repo/my-feature -b my-feature origin/main
cd /work/players/YOUR_NAME/worktrees/owner--repo/my-feature
# ... make changes, commit ...
git push -u origin my-feature
gh pr create --title "..." --body "..."
\`\`\`

**Do NOT modify the shared clone directly** — always use a worktree for changes.

## Instructions

1. Create a feature branch and worktree
2. Make focused, small changes
3. Run tests if available
4. Commit with clear messages and your sign-off
5. Push and create a PR with a good description

Report what you changed, test results, and the PR URL.`
}

function subagentReview(ctx: SubagentPromptContext): string {
  return `You are reviewing a pull request.

${subagentCommon(ctx)}

## Instructions

1. Read the PR description: \`gh pr view <number>\`
2. Read the diff carefully: \`gh pr diff <number>\`
3. Check for:
   - Correctness: Does the code do what it claims?
   - Edge cases: Are boundary conditions handled?
   - Style: Is the code clean and consistent?
   - Tests: Are changes tested?
4. Submit your review: \`gh pr review <number> --approve\` or \`--request-changes --body "..."\`

Be constructive and specific. Point to exact lines when noting issues.

Report your review decision and key findings.`
}

function subagentInvestigateCi(ctx: SubagentPromptContext): string {
  return `You are investigating CI failures.

${subagentCommon(ctx)}

## Instructions

1. List recent CI runs: \`gh run list\`
2. View failed run details: \`gh run view <id> --log-failed\`
3. Identify the root cause of the failure
4. Check if it's a flaky test, a real bug, or a configuration issue

Report:
- Which run failed and on which branch
- The specific error/failure
- Root cause analysis
- Suggested fix`
}

function subagentDiary(ctx: SubagentPromptContext): string {
  return `You are updating your diary.

${subagentCommon(ctx)}

## Instructions

Update ./me/DIARY.md with a brief entry about what you accomplished, what you learned, and what to focus on next. Append to the existing content, don't replace it.`
}

function subagentDefault(ctx: SubagentPromptContext): string {
  const state = ctx.state as GitHubState
  const situation = ctx.situation as GitHubSituation

  return `You are working across ${state.repos.length} repositor${state.repos.length === 1 ? "y" : "ies"}.

${subagentCommon(ctx)}

## Tools
Use the \`gh\` CLI for GitHub operations and \`git\` for repository operations.

## Git Worktree Workflow
Each repo has a **shared clone** (on main) and your **worktree directory** for feature branches.
For read-only tasks (triage, review), you can \`cd\` to the shared clone or use \`gh\`.

Complete your task and report what you did.`
}

const SUBAGENT_PROMPT_BY_TASK: Record<string, (ctx: SubagentPromptContext) => string> = {
  investigate: subagentInvestigate,
  triage: subagentTriage,
  code: subagentCode,
  review: subagentReview,
  investigate_ci: subagentInvestigateCi,
  diary: subagentDiary,
}

// ── Prompt builder implementation ───────────────────────────

const gitHubPromptBuilder: PromptBuilder = {
  planPrompt(ctx: PlanPromptContext): string {
    const promptFn = PLAN_PROMPT_BY_MODE[ctx.mode] ?? planPromptSelect
    return promptFn(ctx)
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

Respond with a new plan as JSON. Pick a procedure for the response if appropriate.

\`\`\`json
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
\`\`\``
  },

  evaluatePrompt(ctx: EvaluatePromptContext): string {
    const secondsConsumed = Math.round(ctx.ticksConsumed * ctx.tickIntervalSec)
    const secondsBudgeted = Math.round(ctx.ticksBudgeted * ctx.tickIntervalSec)
    const overrunDelta = ctx.ticksConsumed - ctx.ticksBudgeted
    const overrunWarning = overrunDelta > 0
      ? `\nWARNING: exceeded tick budget by ${overrunDelta} ticks.`
      : ""

    const modeHint = ctx.mode === "select"
      ? "\nThis was an investigation step. If findings are sufficient, mark complete so the brain can pick a procedure next."
      : ""

    return `Evaluate whether this step was completed successfully.

## Step
Goal: ${ctx.step.goal}
Success condition: ${ctx.step.successCondition}

## Subagent Report
${ctx.subagentReport.slice(-2000)}

## State Changes
${ctx.stateDiff}

## Condition Check
Condition: "${ctx.step.successCondition}"
Result: ${ctx.conditionCheck.complete ? "PASS" : "FAIL"} - ${ctx.conditionCheck.reason}

The deterministic check is advisory. Use the subagent report and state changes to judge completion.

## Timing
Consumed ${ctx.ticksConsumed} of ${ctx.ticksBudgeted} ticks (~${secondsConsumed}s of ~${secondsBudgeted}s).${overrunWarning}
${modeHint}
Respond with JSON:
\`\`\`json
{
  "complete": true,
  "reason": "Why the step is/isn't complete"
}
\`\`\``
  },

  subagentPrompt(ctx: SubagentPromptContext): string {
    const promptFn = SUBAGENT_PROMPT_BY_TASK[ctx.step.task] ?? subagentDefault
    return promptFn(ctx)
  },

  systemPrompt(): string {
    return `# GitHub Agent

You are a software engineer working across one or more GitHub repositories. You have access to the \`gh\` CLI and \`git\` for all operations.

## Approach

You follow an investigation-first approach:
1. First gather context — read issues, PRs, diffs, CI logs
2. Then act on specific items with focused changes
3. Report findings at the end of every task

## Available Tools

- \`gh issue list\` / \`gh issue view <number>\` — browse issues
- \`gh issue edit <number> --add-label <label>\` — triage issues
- \`gh issue comment <number> --body "..."\` — comment on issues
- \`gh pr list\` / \`gh pr view <number>\` — browse PRs
- \`gh pr diff <number>\` — read PR diffs
- \`gh pr review <number> --approve\` / \`--request-changes\` — review PRs
- \`gh pr checkout <number>\` — check out a PR locally
- \`gh run list\` / \`gh run view <id>\` — inspect CI runs
- \`gh run view <id> --log-failed\` — read CI failure logs
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
- Report your findings at the end of every task

## Diary

Your ./me/DIARY.md tracks your beliefs, accomplishments, and plans across sessions. Update it at the end of each shift.

**never** ask "what should I do?" — you decide based on repository state and your priorities.`
  },
}

/** Layer providing the GitHub prompt builder. */
export const GitHubPromptBuilderLive = Layer.succeed(PromptBuilderTag, gitHubPromptBuilder)
