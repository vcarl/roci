import { Layer } from "effect"
import type { StateRenderer } from "../../core/state-renderer.js"
import { StateRendererTag } from "../../core/state-renderer.js"
import type { RepoState, GitHubSituation } from "./types.js"

function snapshot(state: RepoState): Record<string, unknown> {
  return {
    repo: `${state.owner}/${state.repo}`,
    openIssues: state.openIssues.length,
    openPRs: state.openPRs.length,
    ciStatus: state.ciStatus,
    tick: state.tick,
  }
}

function richSnapshot(state: RepoState): Record<string, unknown> {
  return {
    ...snapshot(state),
    issues: state.openIssues.map((i) => ({
      number: i.number,
      title: i.title,
      labels: i.labels,
      author: i.author,
    })),
    prs: state.openPRs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      author: pr.author,
      draft: pr.draft,
      checks: pr.checks,
      reviewStatus: pr.reviewStatus,
    })),
    recentActivity: state.recentActivity,
  }
}

function stateDiff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): string {
  if (!before) return "(no before-state captured)"
  const changes: string[] = []
  if (before.openIssues !== after.openIssues)
    changes.push(`Issues: ${before.openIssues} -> ${after.openIssues}`)
  if (before.openPRs !== after.openPRs)
    changes.push(`PRs: ${before.openPRs} -> ${after.openPRs}`)
  if (before.ciStatus !== after.ciStatus)
    changes.push(`CI: ${before.ciStatus} -> ${after.ciStatus}`)
  return changes.length > 0 ? changes.join("; ") : "(no changes detected)"
}

function renderForPlanning(state: RepoState, situation: GitHubSituation): string {
  const lines: string[] = [
    `## ${state.owner}/${state.repo}`,
    `CI: ${state.ciStatus} | Situation: ${situation.type}`,
    "",
  ]

  if (state.openIssues.length > 0) {
    lines.push("### Open Issues")
    for (const issue of state.openIssues) {
      const labels = issue.labels.length > 0 ? ` [${issue.labels.join(", ")}]` : ""
      lines.push(`- #${issue.number}: ${issue.title}${labels} (by ${issue.author})`)
    }
    lines.push("")
  }

  if (state.openPRs.length > 0) {
    lines.push("### Open PRs")
    for (const pr of state.openPRs) {
      const status = pr.draft ? "draft" : `checks:${pr.checks} review:${pr.reviewStatus}`
      lines.push(`- #${pr.number}: ${pr.title} (${status}, by ${pr.author})`)
    }
    lines.push("")
  }

  return lines.join("\n")
}

function logStateBar(name: string, state: RepoState, situation: GitHubSituation): void {
  const line = `[${name}] ${state.owner}/${state.repo} | issues:${state.openIssues.length} prs:${state.openPRs.length} ci:${state.ciStatus} | ${situation.type}`
  process.stderr.write(`\r${line}`)
}

const gitHubStateRenderer: StateRenderer = {
  snapshot(state) {
    return snapshot(state as RepoState)
  },
  richSnapshot(state) {
    return richSnapshot(state as RepoState)
  },
  stateDiff(before, after) {
    return stateDiff(before, after)
  },
  renderForPlanning(state, situation) {
    return renderForPlanning(state as RepoState, situation as GitHubSituation)
  },
  logStateBar(name, state, situation) {
    logStateBar(name, state as RepoState, situation as GitHubSituation)
  },
}

/** Layer providing the GitHub state renderer. */
export const GitHubStateRendererLive = Layer.succeed(StateRendererTag, gitHubStateRenderer)
