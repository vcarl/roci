import { Context, Effect, Queue, Schedule, Layer, Scope } from "effect"
import type { GitHubState, GitHubEvent, RepoState, Issue, IssueComment, PullRequest, PullRequestReview, RepoCommit } from "./types.js"

export interface GitHubClientConfig {
  readonly repos: Array<{ owner: string; repo: string }>
  readonly pollIntervalMs: number
  readonly token: string
}

export interface GitHubClient {
  /** Start polling and return the event queue + initial state. */
  readonly connect: (config: GitHubClientConfig) => Effect.Effect<{
    events: Queue.Queue<GitHubEvent>
    initialState: GitHubState
    tickIntervalSec: number
    initialTick: number
    authenticatedUser: string
  }, never, Scope.Scope>
}

export class GitHubClientTag extends Context.Tag("GitHubClient")<GitHubClientTag, GitHubClient>() {}

/** Standard GitHub API headers. Works with both classic PATs (ghp_) and fine-grained tokens. */
function apiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  }
}

/** Fetch JSON from a URL with error handling — includes response body in errors. */
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

/** Derive review status from a list of reviews. */
function deriveReviewStatus(reviews: PullRequestReview[]): PullRequest["reviewStatus"] {
  if (reviews.length === 0) return "review_required"

  // Get latest non-COMMENTED, non-DISMISSED review per reviewer
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

/** Derive check status from check runs API response. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deriveCheckStatus(checkRuns: any[]): PullRequest["checks"] {
  if (checkRuns.length === 0) return "pending"
  const allSuccess = checkRuns.every(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cr: any) => cr.status === "completed" && cr.conclusion === "success",
  )
  if (allSuccess) return "passing"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyFailure = checkRuns.some(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cr: any) => cr.status === "completed" && cr.conclusion === "failure",
  )
  if (anyFailure) return "failing"
  return "pending"
}

/** Validate that a token looks plausible before making API calls. */
function validateToken(token: string): Effect.Effect<void, Error> {
  if (!token || token === "ghp_placeholder") {
    return Effect.fail(new Error(
      "GitHub token is missing or placeholder. Set a real token in github.json"
    ))
  }
  return Effect.void
}

/**
 * Fetch current state for a single repo from the GitHub REST API.
 */
const fetchRepoState = (owner: string, repo: string, token: string) =>
  Effect.gen(function* () {
    const headers = apiHeaders(token)
    const base = `https://api.github.com/repos/${owner}/${repo}`

    // Parallel fetch: issues, PRs, workflow runs, recent commits
    const [rawIssues, rawPRs, rawRuns, rawCommits] = yield* Effect.all([
      fetchJson(`${base}/issues?state=open&per_page=30`, headers),
      fetchJson(`${base}/pulls?state=open&per_page=30`, headers),
      fetchJson(`${base}/actions/runs?per_page=5&branch=main`, headers),
      fetchJson(`${base}/commits?per_page=10`, headers),
    ], { concurrency: 4 })

    // Map issues (filter out PRs — GitHub returns PRs in the issues endpoint)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const issuesWithoutPRs = (rawIssues as any[]).filter((i: any) => !i.pull_request)

    // Fetch recent comments for each issue (last 3 per issue, in parallel)
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

    // Map PRs (initial pass — reviews/checks enriched below)
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

    // Enrich each PR with real reviews and check status (concurrency 5)
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
          let checkRuns = ((rawCheckRuns as any).check_runs ?? []) as any[]

          // Fall back to legacy status API if no check runs
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
            return {
              ...pr,
              reviews,
              reviewStatus: deriveReviewStatus(reviews),
              checks: legacyChecks,
            }
          }

          return {
            ...pr,
            reviews,
            reviewStatus: deriveReviewStatus(reviews),
            checks: deriveCheckStatus(checkRuns),
          }
        }).pipe(
          Effect.catchAll(() => Effect.succeed(pr)),
        ),
      ),
      { concurrency: 5 },
    )

    // Map recent commits
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recentCommits: RepoCommit[] = (rawCommits as any[]).slice(0, 10).map((c: any) => ({
      sha: (c.sha as string).slice(0, 7),
      message: (c.commit?.message ?? "").split("\n")[0].slice(0, 120),
      author: c.commit?.author?.name ?? c.author?.login ?? "unknown",
      date: c.commit?.author?.date ?? "",
    }))

    // Derive CI status from most recent workflow run
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runs = (rawRuns as any).workflow_runs ?? []
    let ciStatus: RepoState["ciStatus"] = "unknown"
    if (runs.length > 0) {
      const latest = runs[0]
      if (latest.conclusion === "success") ciStatus = "passing"
      else if (latest.conclusion === "failure") ciStatus = "failing"
    }

    const state: RepoState = {
      owner,
      repo,
      openIssues,
      openPRs,
      ciStatus,
      recentCommits,
      recentActivity: [],
      clonePath: "",
      worktreePath: null,
      currentBranch: null,
    }

    return state
  })

/**
 * GitHub client that polls the REST API for repo state across multiple repos.
 */
export const GitHubClientLive = Layer.succeed(GitHubClientTag, {
  connect: (config: GitHubClientConfig) =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<GitHubEvent>()
      const { repos, token } = config

      // Validate token before attempting any API calls
      yield* validateToken(token).pipe(
        Effect.catchAll((e) => Effect.logWarning(`Token validation: ${e.message}`)),
      )

      // Fetch authenticated username
      const authenticatedUser = yield* fetchJson("https://api.github.com/user", apiHeaders(token)).pipe(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Effect.map((u: any) => (u as { login: string }).login),
        Effect.catchAll(() => Effect.succeed("")),
      )

      // Initial fetch for all repos
      const initialRepos = yield* Effect.all(
        repos.map(({ owner, repo }) =>
          fetchRepoState(owner, repo, token).pipe(
            Effect.catchAll((e) => {
              return Effect.logWarning(`Initial fetch failed for ${owner}/${repo}: ${e.message}`).pipe(
                Effect.map((): RepoState => ({
                  owner, repo,
                  openIssues: [], openPRs: [],
                  ciStatus: "unknown" as const,
                  recentCommits: [],
                  recentActivity: [],
                  clonePath: "",
                  worktreePath: null,
                  currentBranch: null,
                })),
              )
            }),
          ),
        ),
        { concurrency: 3 },
      )

      const initialState: GitHubState = {
        repos: initialRepos,
        tick: 0,
        timestamp: Date.now(),
        authenticatedUser,
      }

      // Background polling fiber — polls all repos each cycle
      let tick = 0
      yield* Effect.gen(function* () {
        tick++
        const repoStates = yield* Effect.all(
          repos.map(({ owner, repo }) => fetchRepoState(owner, repo, token)),
          { concurrency: 3 },
        )
        for (let i = 0; i < repoStates.length; i++) {
          yield* Queue.offer(events, {
            type: "poll_update",
            payload: { repoIndex: i, repoState: repoStates[i] },
          })
        }
        yield* Queue.offer(events, { type: "tick", payload: { tick } })
      }).pipe(
        Effect.repeat(Schedule.spaced(config.pollIntervalMs)),
        Effect.catchAll((e) => {
          return Effect.logWarning(`GitHub poll error: ${e.message}`)
        }),
        Effect.forkScoped,
      )

      return {
        events,
        initialState,
        tickIntervalSec: Math.round(config.pollIntervalMs / 1000),
        initialTick: 0,
        authenticatedUser,
      }
    }),
})
