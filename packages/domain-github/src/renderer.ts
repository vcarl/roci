import { Layer } from "effect"
import type { StateRenderer } from "@roci/core/core/state-renderer.js"
import { StateRendererTag } from "@roci/core/core/state-renderer.js"
import type { GitHubState } from "./types.js"

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
        assignees: i.assignees,
        author: i.author,
      })),
      prs: r.openPRs.map((pr) => ({
        number: pr.number,
        title: pr.title,
        author: pr.author,
        draft: pr.draft,
        checks: pr.checks,
        reviewStatus: pr.reviewStatus,
        reviewers: pr.reviews.map((rv) => `${rv.reviewer}:${rv.state}`),
        requestedReviewers: pr.requestedReviewers,
      })),
    })),
  }
}

interface RichRepoSnapshot {
  repo: string
  openIssues: number
  openPRs: number
  ciStatus: string
  issues?: Array<{ number: number; title: string; labels: string[]; assignees: string[] }>
  prs?: Array<{ number: number; title: string; checks: string; reviewStatus: string; requestedReviewers: string[] }>
}

function stateDiff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): string {
  if (!before) return "(no before-state captured)"
  const beforeRepos = (before.repos ?? []) as RichRepoSnapshot[]
  const afterRepos = (after.repos ?? []) as RichRepoSnapshot[]
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

    // Track label changes on issues
    if (b.issues && a.issues) {
      const beforeIssueMap = new Map(b.issues.map((i) => [i.number, i]))
      for (const afterIssue of a.issues) {
        const beforeIssue = beforeIssueMap.get(afterIssue.number)
        if (!beforeIssue) {
          changes.push(`${repo} #${afterIssue.number}: new issue "${afterIssue.title}"`)
          continue
        }
        const addedLabels = afterIssue.labels.filter((l) => !beforeIssue.labels.includes(l))
        const removedLabels = beforeIssue.labels.filter((l) => !afterIssue.labels.includes(l))
        if (addedLabels.length > 0) {
          changes.push(`${repo} #${afterIssue.number}: +labels [${addedLabels.join(", ")}]`)
        }
        if (removedLabels.length > 0) {
          changes.push(`${repo} #${afterIssue.number}: -labels [${removedLabels.join(", ")}]`)
        }
        const addedAssignees = (afterIssue.assignees ?? []).filter((a) => !(beforeIssue.assignees ?? []).includes(a))
        const removedAssignees = (beforeIssue.assignees ?? []).filter((a) => !(afterIssue.assignees ?? []).includes(a))
        if (addedAssignees.length > 0) {
          changes.push(`${repo} #${afterIssue.number}: +assigned [${addedAssignees.join(", ")}]`)
        }
        if (removedAssignees.length > 0) {
          changes.push(`${repo} #${afterIssue.number}: -assigned [${removedAssignees.join(", ")}]`)
        }
      }
    }

    // Track new PRs and review status changes
    if (b.prs && a.prs) {
      const beforePrMap = new Map(b.prs.map((p) => [p.number, p]))
      for (const afterPr of a.prs) {
        const beforePr = beforePrMap.get(afterPr.number)
        if (!beforePr) {
          changes.push(`${repo} #${afterPr.number}: new PR "${afterPr.title}"`)
          continue
        }
        if (beforePr.reviewStatus !== afterPr.reviewStatus) {
          changes.push(`${repo} PR #${afterPr.number} review: ${beforePr.reviewStatus} -> ${afterPr.reviewStatus}`)
        }
        if (beforePr.checks !== afterPr.checks) {
          changes.push(`${repo} PR #${afterPr.number} checks: ${beforePr.checks} -> ${afterPr.checks}`)
        }
        const addedReviewers = (afterPr.requestedReviewers ?? []).filter((r) => !(beforePr.requestedReviewers ?? []).includes(r))
        const removedReviewers = (beforePr.requestedReviewers ?? []).filter((r) => !(afterPr.requestedReviewers ?? []).includes(r))
        if (addedReviewers.length > 0) {
          changes.push(`${repo} PR #${afterPr.number}: +review requested [${addedReviewers.join(", ")}]`)
        }
        if (removedReviewers.length > 0) {
          changes.push(`${repo} PR #${afterPr.number}: -review requested [${removedReviewers.join(", ")}]`)
        }
      }
    }
  }
  return changes.length > 0 ? changes.join("; ") : "(no changes detected)"
}

function logStateBar(name: string, metrics: Record<string, string | number | boolean>): void {
  const parts: string[] = []
  if (metrics.totalRepos !== undefined) parts.push(`repos:${metrics.totalRepos}`)
  if (metrics.openIssues !== undefined) parts.push(`issues:${metrics.openIssues}`)
  if (metrics.openPRs !== undefined) parts.push(`PRs:${metrics.openPRs}`)
  if (metrics.ciFailingRepos !== undefined && Number(metrics.ciFailingRepos) > 0) parts.push(`CI-fail:${metrics.ciFailingRepos}`)
  const line = `[${name}] ${parts.join(" ")}`
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
  logStateBar(name, metrics) {
    logStateBar(name, metrics)
  },
}

/** Layer providing the GitHub state renderer. */
export const GitHubStateRendererLive = Layer.succeed(StateRendererTag, gitHubStateRenderer)
