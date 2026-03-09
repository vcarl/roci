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

/** Execute a GraphQL query against GitHub's API. */
const graphql = (token: string, query: string, variables: Record<string, unknown> = {}) =>
  Effect.tryPromise({
    try: async () => {
      const r = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          Authorization: `bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      })
      if (!r.ok) {
        const body = await r.text().catch(() => "(no body)")
        throw new Error(`GitHub GraphQL ${r.status}: ${r.statusText} — ${body}`)
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json = await r.json() as any
      if (json.errors?.length) {
        throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`)
      }
      return json.data
    },
    catch: (e) => new Error(`GitHub GraphQL failed: ${e}`),
  })

const REPO_STATE_QUERY = `
query RepoState($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    issues(first: 30, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        title
        author { login }
        createdAt
        updatedAt
        body
        labels(first: 10) { nodes { name } }
        assignees(first: 10) { nodes { login } }
        comments(last: 3) {
          totalCount
          nodes {
            author { login }
            createdAt
            body
          }
        }
      }
    }
    pullRequests(first: 30, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        title
        author { login }
        isDraft
        createdAt
        headRefOid
        reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } } } }
        reviews(last: 10) {
          nodes {
            author { login }
            state
            submittedAt
          }
        }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: 30) {
                  nodes {
                    ... on CheckRun {
                      __typename
                      status
                      conclusion
                    }
                    ... on StatusContext {
                      __typename
                      state
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    defaultBranchRef {
      target {
        ... on Commit {
          history(first: 10) {
            nodes {
              oid
              message
              author { name user { login } }
              committedDate
            }
          }
          checkSuites(last: 1) {
            nodes {
              conclusion
            }
          }
        }
      }
    }
  }
}
`

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deriveChecksFromRollup(contexts: any[]): PullRequest["checks"] {
  if (contexts.length === 0) return "pending"
  const allSuccess = contexts.every((c) => {
    if (c.__typename === "CheckRun") return c.status === "COMPLETED" && c.conclusion === "SUCCESS"
    if (c.__typename === "StatusContext") return c.state === "SUCCESS"
    return false
  })
  if (allSuccess) return "passing"
  const anyFailure = contexts.some((c) => {
    if (c.__typename === "CheckRun") return c.status === "COMPLETED" && c.conclusion === "FAILURE"
    if (c.__typename === "StatusContext") return c.state === "FAILURE" || c.state === "ERROR"
    return false
  })
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
 * Fetch current state for a single repo via GitHub GraphQL API (1 request).
 */
const fetchRepoState = (owner: string, repo: string, token: string) =>
  Effect.gen(function* () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = yield* graphql(token, REPO_STATE_QUERY, { owner, repo }) as Effect.Effect<any, Error>
    const repoData = data.repository

    // Map issues
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const openIssues: Issue[] = (repoData.issues.nodes ?? []).map((i: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const recentComments: IssueComment[] = (i.comments.nodes ?? []).map((c: any) => ({
        author: c.author?.login ?? "unknown",
        createdAt: c.createdAt,
        body: (c.body ?? "").slice(0, 300),
      }))
      return {
        number: i.number,
        title: i.title,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        labels: (i.labels.nodes ?? []).map((l: any) => l.name),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        assignees: (i.assignees.nodes ?? []).map((a: any) => a.login),
        author: i.author?.login ?? "unknown",
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
        body: (i.body ?? "").slice(0, 500),
        commentCount: i.comments.totalCount ?? 0,
        recentComments,
      }
    })

    // Map PRs
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const openPRs: PullRequest[] = (repoData.pullRequests.nodes ?? []).map((pr: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reviews: PullRequestReview[] = (pr.reviews.nodes ?? []).map((r: any) => ({
        reviewer: r.author?.login ?? "unknown",
        state: r.state as PullRequestReview["state"],
        submittedAt: r.submittedAt ?? "",
      }))

      const commitNode = pr.commits?.nodes?.[0]?.commit
      const rollup = commitNode?.statusCheckRollup
      const contexts = rollup?.contexts?.nodes ?? []
      let checks: PullRequest["checks"]
      if (!rollup) {
        checks = "pending"
      } else if (rollup.state === "SUCCESS") {
        checks = "passing"
      } else if (rollup.state === "FAILURE" || rollup.state === "ERROR") {
        checks = "failing"
      } else {
        checks = deriveChecksFromRollup(contexts)
      }

      return {
        number: pr.number,
        title: pr.title,
        author: pr.author?.login ?? "unknown",
        draft: pr.isDraft ?? false,
        headSha: pr.headRefOid ?? "",
        checks,
        reviewStatus: deriveReviewStatus(reviews),
        reviews,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        requestedReviewers: (pr.reviewRequests.nodes ?? [])
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((rr: any) => rr.requestedReviewer?.login)
          .filter(Boolean) as string[],
        createdAt: pr.createdAt,
      }
    })

    // Map recent commits from default branch
    const commitHistory = repoData.defaultBranchRef?.target?.history?.nodes ?? []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recentCommits: RepoCommit[] = commitHistory.map((c: any) => ({
      sha: (c.oid as string).slice(0, 7),
      message: (c.message ?? "").split("\n")[0].slice(0, 120),
      author: c.author?.name ?? c.author?.user?.login ?? "unknown",
      date: c.committedDate ?? "",
    }))

    // CI status from default branch's latest check suite
    const checkSuites = repoData.defaultBranchRef?.target?.checkSuites?.nodes ?? []
    let ciStatus: RepoState["ciStatus"] = "unknown"
    if (checkSuites.length > 0) {
      const conclusion = checkSuites[0]?.conclusion
      if (conclusion === "SUCCESS") ciStatus = "passing"
      else if (conclusion === "FAILURE") ciStatus = "failing"
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
 * GitHub client that polls repo state via GraphQL (1 query per repo per poll).
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

      // Fetch authenticated username via GraphQL viewer query
      const authenticatedUser = yield* graphql(token, `query { viewer { login } }`).pipe(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Effect.map((d: any) => d.viewer.login as string),
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
