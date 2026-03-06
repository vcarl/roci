import { Layer } from "effect"
import type { StateRenderer } from "../../core/state-renderer.js"
import { StateRendererTag } from "../../core/state-renderer.js"
import type { GitHubState, GitHubSituation } from "./types.js"

function snapshot(state: GitHubState): Record<string, unknown> {
  return {
    repos: state.repos.map((r) => ({
      repo: `${r.owner}/${r.repo}`,
      openIssues: r.openIssues.length,
      openPRs: r.openPRs.length,
      ciStatus: r.ciStatus,
    })),
    tick: state.tick,
  }
}

function richSnapshot(state: GitHubState): Record<string, unknown> {
  return {
    ...snapshot(state),
    repos: state.repos.map((r) => ({
      repo: `${r.owner}/${r.repo}`,
      openIssues: r.openIssues.length,
      openPRs: r.openPRs.length,
      ciStatus: r.ciStatus,
      clonePath: r.clonePath,
      worktreePath: r.worktreePath,
      currentBranch: r.currentBranch,
      issues: r.openIssues.map((i) => ({
        number: i.number,
        title: i.title,
        labels: i.labels,
        author: i.author,
      })),
      prs: r.openPRs.map((pr) => ({
        number: pr.number,
        title: pr.title,
        author: pr.author,
        draft: pr.draft,
        checks: pr.checks,
        reviewStatus: pr.reviewStatus,
      })),
    })),
  }
}

function stateDiff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): string {
  if (!before) return "(no before-state captured)"
  // Compare repo-level counts
  const beforeRepos = (before.repos ?? []) as Array<Record<string, unknown>>
  const afterRepos = (after.repos ?? []) as Array<Record<string, unknown>>
  const changes: string[] = []
  for (let i = 0; i < afterRepos.length; i++) {
    const b = beforeRepos[i]
    const a = afterRepos[i]
    if (!b || !a) continue
    const repo = a.repo as string
    if (b.openIssues !== a.openIssues)
      changes.push(`${repo} issues: ${b.openIssues} -> ${a.openIssues}`)
    if (b.openPRs !== a.openPRs)
      changes.push(`${repo} PRs: ${b.openPRs} -> ${a.openPRs}`)
    if (b.ciStatus !== a.ciStatus)
      changes.push(`${repo} CI: ${b.ciStatus} -> ${a.ciStatus}`)
  }
  return changes.length > 0 ? changes.join("; ") : "(no changes detected)"
}

function renderForPlanning(state: GitHubState, situation: GitHubSituation): string {
  const sections: string[] = []

  for (let i = 0; i < state.repos.length; i++) {
    const repo = state.repos[i]
    const sit = situation.repos[i]
    const lines: string[] = [
      `## ${repo.owner}/${repo.repo}`,
      `CI: ${repo.ciStatus} | Situation: ${sit?.type ?? "unknown"}`,
    ]

    lines.push(`Shared clone: \`${repo.clonePath}\``)
    if (repo.worktreePath) {
      lines.push(`Worktree: \`${repo.worktreePath}\` (branch: ${repo.currentBranch ?? "unknown"})`)
    }
    lines.push("")

    if (repo.openIssues.length > 0) {
      lines.push("### Open Issues")
      for (const issue of repo.openIssues) {
        const labels = issue.labels.length > 0 ? ` [${issue.labels.join(", ")}]` : ""
        lines.push(`- #${issue.number}: ${issue.title}${labels} (by ${issue.author})`)
      }
      lines.push("")
    }

    if (repo.openPRs.length > 0) {
      lines.push("### Open PRs")
      for (const pr of repo.openPRs) {
        const status = pr.draft ? "draft" : `checks:${pr.checks} review:${pr.reviewStatus}`
        lines.push(`- #${pr.number}: ${pr.title} (${status}, by ${pr.author})`)
      }
      lines.push("")
    }

    sections.push(lines.join("\n"))
  }

  return sections.join("\n---\n\n")
}

function logStateBar(name: string, state: GitHubState, situation: GitHubSituation): void {
  const repoSummaries = state.repos.map((r) =>
    `${r.owner}/${r.repo}:i${r.openIssues.length}/p${r.openPRs.length}/${r.ciStatus}`,
  )
  const line = `[${name}] ${repoSummaries.join(" ")} | ${situation.type}`
  process.stderr.write(`\r${line}`)
}

const gitHubStateRenderer: StateRenderer = {
  snapshot(state) {
    return snapshot(state as GitHubState)
  },
  richSnapshot(state) {
    return richSnapshot(state as GitHubState)
  },
  stateDiff(before, after) {
    return stateDiff(before, after)
  },
  renderForPlanning(state, situation) {
    return renderForPlanning(state as GitHubState, situation as GitHubSituation)
  },
  logStateBar(name, state, situation) {
    logStateBar(name, state as GitHubState, situation as GitHubSituation)
  },
}

/** Layer providing the GitHub state renderer. */
export const GitHubStateRendererLive = Layer.succeed(StateRendererTag, gitHubStateRenderer)
