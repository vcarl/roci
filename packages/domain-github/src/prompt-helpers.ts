import type { PlanPromptContext, SubagentPromptContext } from "@signal/core/core/prompt-builder.js"
import type { GitHubState, GitHubSituation } from "./types.js"

export function renderReposSummary(state: GitHubState, situation: GitHubSituation): string {
  const authUser = state.authenticatedUser
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
      (pr) => !pr.draft && pr.checks === "passing" && pr.reviewStatus === "review_required"
        && pr.author !== authUser,
    )
    if (reviewable.length > 0) lines.push(`PRs ready for review: ${reviewable.length}`)

    return lines.join("\n")
  }).join("\n\n")
}

export function buildTimingSection(ctx: PlanPromptContext): string {
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

export function renderIdentitySection(ctx: { background: string; values: string }): string {
  return `## Your Identity
${ctx.background}

## Your Values
${ctx.values}`
}

export function renderProcedureContext(ctx: PlanPromptContext): string {
  const sections: string[] = []
  if (ctx.procedureTargets && ctx.procedureTargets.length > 0) {
    sections.push(`## Procedure Targets\nYou are focused on: ${ctx.procedureTargets.join(", ")}`)
  }
  if (ctx.investigationReport) {
    sections.push(`## Investigation Findings\n${ctx.investigationReport.slice(-2000)}`)
  }
  return sections.join("\n\n")
}

export function subagentCommon(ctx: SubagentPromptContext): string {
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
