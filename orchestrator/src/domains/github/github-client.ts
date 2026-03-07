import { Context, Effect, Queue, Schedule, Layer, Scope } from "effect"
import type { GitHubState, GitHubEvent, RepoState, Issue, IssueComment, PullRequest, RepoCommit } from "./types.js"

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

    // Map PRs
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const openPRs: PullRequest[] = (rawPRs as any[]).map((pr: any) => ({
      number: pr.number,
      title: pr.title,
      author: pr.user?.login ?? "unknown",
      draft: pr.draft ?? false,
      checks: "pending" as const,
      reviewStatus: "none" as const,
      createdAt: pr.created_at,
    }))

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

      // Initial fetch for all repos
      const initialRepos = yield* Effect.all(
        repos.map(({ owner, repo }) =>
          fetchRepoState(owner, repo, token).pipe(
            Effect.catchAll((e) => {
              return Effect.logWarning(`Initial fetch failed for ${owner}/${repo}: ${e.message}`).pipe(
                Effect.map(() => ({
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
      }
    }),
})
