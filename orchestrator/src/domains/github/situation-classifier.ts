import { Layer } from "effect"
import type { SituationClassifier } from "../../core/limbic/amygdala/situation.js"
import { SituationClassifierTag } from "../../core/limbic/amygdala/situation.js"
import type { GitHubState, GitHubSituation, GitHubSituationType, RepoState, RepoSituation } from "./types.js"

const STALE_PR_DAYS = 7

/** Priority order for situation types (worst first). */
const SITUATION_PRIORITY: GitHubSituationType[] = [
  "ci_failing", "triage_needed", "review_needed", "work_available", "idle",
]

function classifyRepo(state: RepoState, authenticatedUser?: string): RepoSituation {
  const ciFailing = state.ciStatus === "failing"
  const untriagedIssues = state.openIssues.some((i) => !i.labels.includes("triaged"))
  const reviewablePRs = state.openPRs.some(
    (pr) => !pr.draft && pr.checks === "passing" && pr.reviewStatus === "review_required"
      && pr.author !== authenticatedUser,
  )
  const cutoff = Date.now() - STALE_PR_DAYS * 24 * 60 * 60 * 1000
  const stalePRs = state.openPRs.some((pr) => new Date(pr.createdAt).getTime() < cutoff)
  const reviewRequested = state.openPRs.some(
    (pr) => !pr.draft && pr.requestedReviewers.includes(authenticatedUser ?? ""),
  )
  const claimedIssueActivity = state.openIssues.some(
    (i) => i.assignees.includes(authenticatedUser ?? "") && i.recentComments.length > 0,
  )

  const flags = { ciFailing, untriagedIssues, reviewablePRs, stalePRs, reviewRequested, claimedIssueActivity }

  let type: GitHubSituationType = "idle"
  if (ciFailing) type = "ci_failing"
  else if (reviewRequested) type = "review_needed"
  else if (untriagedIssues) type = "triage_needed"
  else if (reviewablePRs) type = "review_needed"
  else if (state.openIssues.length > 0) type = "work_available"

  return { owner: state.owner, repo: state.repo, type, flags }
}

function classify(state: GitHubState): GitHubSituation {
  const repos = state.repos.map((r) => classifyRepo(r, state.authenticatedUser))

  // Overall situation = worst across all repos
  const worstType = repos.reduce<GitHubSituationType>((worst, r) => {
    return SITUATION_PRIORITY.indexOf(r.type) < SITUATION_PRIORITY.indexOf(worst)
      ? r.type
      : worst
  }, "idle")

  return { type: worstType, repos, alerts: [] }
}

function briefing(state: GitHubState, situation: GitHubSituation): string {
  const sections = state.repos.map((repo, i) => {
    const sit = situation.repos[i]
    const authUser = state.authenticatedUser
    const lines: string[] = []

    // Header with situation type
    const branch = repo.currentBranch ?? "none"
    lines.push(`## ${repo.owner}/${repo.repo} — ${sit?.type ?? "?"}`)
    lines.push(`CI: ${repo.ciStatus} | Branch: ${branch} | Worktree: ${repo.worktreePath ?? "none"}`)

    // Issues breakdown — only show issues active in the past 14 days
    if (repo.openIssues.length > 0) {
      const recencyCutoff = Date.now() - 14 * 24 * 60 * 60 * 1000
      const recent = repo.openIssues.filter(i => new Date(i.updatedAt).getTime() >= recencyCutoff)
      const older = repo.openIssues.length - recent.length
      const untriaged = repo.openIssues.filter(i => !i.labels.includes("triaged"))
      const triaged = repo.openIssues.filter(i => i.labels.includes("triaged"))
      lines.push(`Issues: ${repo.openIssues.length} open (${untriaged.length} untriaged, ${triaged.length} triaged)`)
      for (const issue of recent) {
        const labels = issue.labels.length > 0 ? ` [${issue.labels.join(", ")}]` : ""
        const commentNote = issue.commentCount > 0 ? ` (${issue.commentCount} comments)` : ""
        const claimed = authUser && issue.assignees.includes(authUser) ? " (assigned to you)" : ""
        lines.push(`  #${issue.number}: ${issue.title}${labels}${commentNote}${claimed}`)
        for (const c of issue.recentComments.slice(0, 2)) {
          lines.push(`    @${c.author}: ${c.body.slice(0, 100)}${c.body.length > 100 ? "..." : ""}`)
        }
      }
      if (older > 0) {
        lines.push(`  (${older} older issue${older === 1 ? "" : "s"} not shown)`)
      }
    } else {
      lines.push("Issues: none")
    }

    // PRs breakdown
    if (repo.openPRs.length > 0) {
      const reviewable = repo.openPRs.filter(
        pr => !pr.draft && pr.checks === "passing" && pr.reviewStatus === "review_required"
          && pr.author !== authUser,
      )
      const failing = repo.openPRs.filter(pr => pr.checks === "failing")
      const drafts = repo.openPRs.filter(pr => pr.draft)
      const summaryParts: string[] = [`${repo.openPRs.length} open`]
      if (reviewable.length > 0) summaryParts.push(`${reviewable.length} ready for review`)
      if (failing.length > 0) summaryParts.push(`${failing.length} failing`)
      if (drafts.length > 0) summaryParts.push(`${drafts.length} draft`)
      lines.push(`PRs: ${summaryParts.join(", ")}`)
      for (const pr of repo.openPRs) {
        const status = pr.draft ? "draft" : `checks:${pr.checks} review:${pr.reviewStatus}`
        const yours = authUser && pr.author === authUser ? " (yours)" : ""
        const reviewReq = authUser && pr.requestedReviewers.includes(authUser) ? " (your review requested)" : ""
        lines.push(`  #${pr.number}: ${pr.title} (${status})${yours}${reviewReq}`)
      }
    } else {
      lines.push("PRs: none")
    }

    // Recent commits
    if (repo.recentCommits.length > 0) {
      lines.push(`Recent commits:`)
      for (const c of repo.recentCommits.slice(0, 5)) {
        lines.push(`  ${c.sha} ${c.message} (${c.author})`)
      }
    }

    // Recent activity
    if (repo.recentActivity.length > 0) {
      lines.push(`Recent: ${repo.recentActivity.slice(-3).join("; ")}`)
    }

    return lines.join("\n")
  })

  return sections.join("\n\n")
}

const gitHubSituationClassifier: SituationClassifier = {
  classify(state) {
    return classify(state as GitHubState)
  },
  briefing(state, situation) {
    return briefing(state as GitHubState, situation as GitHubSituation)
  },
}

/** Layer providing the GitHub situation classifier. */
export const GitHubSituationClassifierLive = Layer.succeed(SituationClassifierTag, gitHubSituationClassifier)
