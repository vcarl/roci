import { Layer } from "effect"
import type {
  PromptBuilder,
  PlanPromptContext,
  InterruptPromptContext,
  EvaluatePromptContext,
  SubagentPromptContext,
} from "../../core/prompt-builder.js"
import { PromptBuilderTag } from "../../core/prompt-builder.js"
import type { RepoState, GitHubSituation } from "./types.js"

function renderRepoSummary(state: RepoState, situation: GitHubSituation): string {
  const lines = [
    `Repository: ${state.owner}/${state.repo}`,
    `CI: ${state.ciStatus} | Situation: ${situation.type}`,
    `Open issues: ${state.openIssues.length} | Open PRs: ${state.openPRs.length}`,
  ]

  const untriaged = state.openIssues.filter((i) => !i.labels.includes("triaged"))
  if (untriaged.length > 0) {
    lines.push(`Untriaged issues: ${untriaged.length}`)
  }

  const reviewable = state.openPRs.filter(
    (pr) => !pr.draft && pr.checks === "passing" && pr.reviewStatus === "review_required",
  )
  if (reviewable.length > 0) {
    lines.push(`PRs ready for review: ${reviewable.length}`)
  }

  return lines.join("\n")
}

const gitHubPromptBuilder: PromptBuilder = {
  planPrompt(ctx: PlanPromptContext): string {
    const state = ctx.state as RepoState
    const situation = ctx.situation as GitHubSituation
    const summary = renderRepoSummary(state, situation)

    const failureSection = ctx.previousFailure
      ? `\n## Previous Plan Failed\n${ctx.previousFailure}\n`
      : ""

    return `You are a software engineer maintaining ${state.owner}/${state.repo}.

## Current State
${summary}
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
Analyze the repository state and create a plan. Your plan should address the most pressing needs first (CI failures > untriaged issues > pending reviews > new work).

Each tick is ${ctx.tickIntervalSec} seconds. Set realistic timeoutTicks for each step.

Respond with a JSON object:
\`\`\`json
{
  "reasoning": "Why this plan makes sense",
  "steps": [
    {
      "task": "triage|code|review|investigate_ci",
      "goal": "What to accomplish",
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
      "goal": "What to accomplish",
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
    const state = ctx.state as RepoState
    const situation = ctx.situation as GitHubSituation
    const summary = renderRepoSummary(state, situation)
    const budgetSeconds = Math.round(ctx.step.timeoutTicks * ctx.identity.tickIntervalSec)

    return `You are working on ${state.owner}/${state.repo}.

## Your Task
Type: ${ctx.step.task}
Goal: ${ctx.step.goal}
Success condition: ${ctx.step.successCondition}
Time budget: ${ctx.step.timeoutTicks} ticks (~${budgetSeconds}s)

## Repository State
${summary}

## Your Identity
${ctx.identity.personality.slice(0, 800)}

## Your Values
${ctx.identity.values.slice(0, 500)}

## Tools
Use the \`gh\` CLI for GitHub operations and \`git\` for repository operations.

Complete your task and report what you did.`
  },

  systemPrompt(): string {
    return `# GitHub Agent

You are a software engineer working on a GitHub repository. You have access to the \`gh\` CLI and \`git\` for all operations.

## Available Tools

- \`gh issue list\` / \`gh issue view <number>\` — browse issues
- \`gh issue edit <number> --add-label <label>\` — triage issues
- \`gh pr list\` / \`gh pr view <number>\` — browse PRs
- \`gh pr review <number> --approve\` / \`--request-changes\` — review PRs
- \`gh pr checkout <number>\` — check out a PR locally
- \`gh run list\` / \`gh run view <id>\` — inspect CI runs
- \`git\` — standard git operations for code changes

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
