import { Effect } from "effect"
import { Docker } from "../../services/Docker.js"
import type { GitHubCharacterConfig } from "./types.js"
import type { RepoState, Issue, IssueComment, PullRequest, PullRequestReview, RepoCommit } from "./types.js"

/** Standard GitHub API headers. */
function apiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  }
}

/** Fetch JSON from GitHub API. */
const fetchJson = (url: string, headers: Record<string, string>) =>
  Effect.tryPromise({
    try: async () => {
      const r = await fetch(url, { headers })
      if (!r.ok) {
        const body = await r.text().catch(() => "(no body)")
        throw new Error(`GitHub API ${r.status}: ${r.statusText} — ${body}`)
      }
      return r.json()
    },
    catch: (e) => new Error(`GitHub API failed: ${e}`),
  })

/** Derive review status from reviews. */
function deriveReviewStatus(reviews: PullRequestReview[]): PullRequest["reviewStatus"] {
  if (reviews.length === 0) return "review_required"
  const latestByReviewer = new Map<string, PullRequestReview>()
  for (const r of reviews) {
    if (r.state === "COMMENTED" || r.state === "DISMISSED") continue
    const existing = latestByReviewer.get(r.reviewer)
    if (!existing || new Date(r.submittedAt) > new Date(existing.submittedAt)) {
      latestByReviewer.set(r.reviewer, r)
    }
  }
  if (latestByReviewer.size === 0) return "review_required"
  const states = [...latestByReviewer.values()].map((r) => r.state)
  if (states.includes("CHANGES_REQUESTED")) return "changes_requested"
  if (states.includes("APPROVED")) return "approved"
  return "review_required"
}

/** Derive check status from check runs. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deriveCheckStatus(checkRuns: any[]): PullRequest["checks"] {
  if (checkRuns.length === 0) return "pending"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allSuccess = checkRuns.every((cr: any) => cr.status === "completed" && cr.conclusion === "success")
  if (allSuccess) return "passing"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyFailure = checkRuns.some((cr: any) => cr.status === "completed" && cr.conclusion === "failure")
  if (anyFailure) return "failing"
  return "pending"
}

/**
 * Fetch current state for a single repo from the GitHub REST API.
 */
export const fetchRepoState = (owner: string, repo: string, token: string) =>
  Effect.gen(function* () {
    const headers = apiHeaders(token)
    const base = `https://api.github.com/repos/${owner}/${repo}`

    const [rawIssues, rawPRs, rawRuns, rawCommits] = yield* Effect.all([
      fetchJson(`${base}/issues?state=open&per_page=30`, headers),
      fetchJson(`${base}/pulls?state=open&per_page=30`, headers),
      fetchJson(`${base}/actions/runs?per_page=5&branch=main`, headers),
      fetchJson(`${base}/commits?per_page=10`, headers),
    ], { concurrency: 4 })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const issuesWithoutPRs = (rawIssues as any[]).filter((i: any) => !i.pull_request)

    const issueCommentResults = yield* Effect.all(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      issuesWithoutPRs.map((i: any) =>
        fetchJson(`${base}/issues/${i.number}/comments?per_page=3&direction=desc`, headers).pipe(
          Effect.catchAll(() => Effect.succeed([])),
        ),
      ),
      { concurrency: 5 },
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const openIssues: Issue[] = issuesWithoutPRs.map((i: any, idx: number) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawComments = (issueCommentResults[idx] as any[]) ?? []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const recentComments: IssueComment[] = rawComments.map((c: any) => ({
        author: c.user?.login ?? "unknown",
        createdAt: c.created_at,
        body: (c.body ?? "").slice(0, 300),
      }))
      return {
        number: i.number,
        title: i.title,
        labels: i.labels?.map((l: { name: string }) => l.name) ?? [],
        author: i.user?.login ?? "unknown",
        createdAt: i.created_at,
        updatedAt: i.updated_at,
        body: (i.body ?? "").slice(0, 500),
        commentCount: i.comments ?? 0,
        recentComments,
      }
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const basePRs: PullRequest[] = (rawPRs as any[]).map((pr: any) => ({
      number: pr.number,
      title: pr.title,
      author: pr.user?.login ?? "unknown",
      draft: pr.draft ?? false,
      headSha: pr.head?.sha ?? "",
      checks: "pending" as const,
      reviewStatus: "review_required" as const,
      reviews: [] as PullRequestReview[],
      createdAt: pr.created_at,
    }))

    const openPRs: PullRequest[] = yield* Effect.all(
      basePRs.map((pr) =>
        Effect.gen(function* () {
          const [rawReviews, rawCheckRuns] = yield* Effect.all([
            fetchJson(`${base}/pulls/${pr.number}/reviews`, headers),
            fetchJson(`${base}/commits/${pr.headSha}/check-runs`, headers),
          ], { concurrency: 2 })

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const reviews: PullRequestReview[] = (rawReviews as any[]).map((r: any) => ({
            reviewer: r.user?.login ?? "unknown",
            state: r.state as PullRequestReview["state"],
            submittedAt: r.submitted_at ?? "",
          }))

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const checkRuns = ((rawCheckRuns as any).check_runs ?? []) as any[]

          if (checkRuns.length === 0 && pr.headSha) {
            const rawStatus = yield* fetchJson(
              `${base}/commits/${pr.headSha}/status`, headers,
            ).pipe(Effect.catchAll(() => Effect.succeed({ state: "pending" })))
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const statusState = (rawStatus as any).state as string
            const legacyChecks: PullRequest["checks"] =
              statusState === "success" ? "passing"
              : statusState === "failure" ? "failing"
              : "pending"
            return { ...pr, reviews, reviewStatus: deriveReviewStatus(reviews), checks: legacyChecks }
          }

          return { ...pr, reviews, reviewStatus: deriveReviewStatus(reviews), checks: deriveCheckStatus(checkRuns) }
        }).pipe(Effect.catchAll(() => Effect.succeed(pr))),
      ),
      { concurrency: 5 },
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recentCommits: RepoCommit[] = (rawCommits as any[]).slice(0, 10).map((c: any) => ({
      sha: (c.sha as string).slice(0, 7),
      message: (c.commit?.message ?? "").split("\n")[0].slice(0, 120),
      author: c.commit?.author?.name ?? c.author?.login ?? "unknown",
      date: c.commit?.author?.date ?? "",
    }))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runs = (rawRuns as any).workflow_runs ?? []
    let ciStatus: RepoState["ciStatus"] = "unknown"
    if (runs.length > 0) {
      const latest = runs[0]
      if (latest.conclusion === "success") ciStatus = "passing"
      else if (latest.conclusion === "failure") ciStatus = "failing"
    }

    return {
      owner, repo, openIssues, openPRs, ciStatus, recentCommits,
      recentActivity: [], clonePath: "", worktreePath: null, currentBranch: null,
    } satisfies RepoState
  })

/**
 * Render repository state as a markdown summary for the brain to read.
 */
function renderRepoState(repo: RepoState, authenticatedUser: string): string {
  const lines: string[] = []
  const isYours = (author: string) => author === authenticatedUser

  lines.push(`## ${repo.owner}/${repo.repo} — CI: ${repo.ciStatus}`)
  lines.push(`Issues: ${repo.openIssues.length} | PRs: ${repo.openPRs.length}`)
  lines.push("")

  if (repo.openIssues.length > 0) {
    lines.push("### Issues")
    for (const issue of repo.openIssues) {
      const labels = issue.labels.length > 0 ? ` [${issue.labels.join(", ")}]` : ""
      const yours = isYours(issue.author) ? " (yours)" : ""
      lines.push(`  #${issue.number}: ${issue.title}${labels}${yours}`)
      if (issue.body) {
        lines.push(`    ${issue.body.slice(0, 200).replace(/\n/g, " ")}`)
      }
      if (issue.recentComments.length > 0) {
        for (const c of issue.recentComments) {
          lines.push(`    > ${c.author}: ${c.body.slice(0, 100).replace(/\n/g, " ")}`)
        }
      }
    }
    lines.push("")
  }

  if (repo.openPRs.length > 0) {
    lines.push("### Pull Requests")
    for (const pr of repo.openPRs) {
      const draft = pr.draft ? " DRAFT" : ""
      const yours = isYours(pr.author) ? " (yours)" : ""
      lines.push(`  #${pr.number}: ${pr.title} (checks:${pr.checks} review:${pr.reviewStatus})${draft}${yours}`)
      if (pr.reviews.length > 0) {
        for (const r of pr.reviews) {
          lines.push(`    review: ${r.reviewer} — ${r.state}`)
        }
      }
    }
    lines.push("")
  }

  if (repo.recentCommits.length > 0) {
    lines.push("### Recent Commits")
    for (const c of repo.recentCommits.slice(0, 5)) {
      lines.push(`  ${c.sha} ${c.message} (${c.author})`)
    }
    lines.push("")
  }

  return lines.join("\n")
}

/**
 * Poll all repos and render a complete state markdown string.
 */
export const pollAndRenderState = (
  ghConfig: GitHubCharacterConfig,
  authenticatedUser: string,
): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    const repos = ghConfig.repos.map((r) => {
      const [owner, repo] = r.split("/")
      return { owner, repo }
    })

    const repoStates = yield* Effect.all(
      repos.map(({ owner, repo }) =>
        fetchRepoState(owner, repo, ghConfig.token).pipe(
          Effect.catchAll((e) => {
            return Effect.logWarning(`Poll failed for ${owner}/${repo}: ${e.message}`).pipe(
              Effect.map((): RepoState => ({
                owner, repo,
                openIssues: [], openPRs: [],
                ciStatus: "unknown" as const,
                recentCommits: [], recentActivity: [],
                clonePath: "", worktreePath: null, currentBranch: null,
              })),
            )
          }),
        ),
      ),
      { concurrency: 3 },
    )

    const timestamp = new Date().toISOString()
    const sections = repoStates.map((r) => renderRepoState(r, authenticatedUser))

    return [
      `# Repository State — ${timestamp}`,
      "",
      ...sections,
    ].join("\n")
  })

/**
 * Poll GitHub and write the state file into the container at the player's directory.
 */
export const pollAndWriteState = (
  containerId: string,
  playerName: string,
  ghConfig: GitHubCharacterConfig,
  authenticatedUser: string,
): Effect.Effect<string, Error | import("../../services/Docker.js").DockerError, Docker> =>
  Effect.gen(function* () {
    const docker = yield* Docker
    const stateMarkdown = yield* pollAndRenderState(ghConfig, authenticatedUser)

    // Write state file into container using base64 to avoid shell escaping issues
    const statePath = `/work/players/${playerName}/state.md`
    const b64 = Buffer.from(stateMarkdown).toString("base64")
    yield* docker.exec(containerId, [
      "bash", "-c", `mkdir -p /work/players/${playerName} && echo '${b64}' | base64 -d > ${statePath}`,
    ])

    return stateMarkdown
  })
