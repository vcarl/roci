import { Context, Effect, Queue, Schedule, Layer, Scope } from "effect"
import type { RepoState, GitHubEvent, Issue, PullRequest } from "./types.js"

export interface GitHubClientConfig {
  readonly owner: string
  readonly repo: string
  readonly pollIntervalMs: number
  readonly token: string
}

export interface GitHubClient {
  /** Start polling and return the event queue + initial state. */
  readonly connect: (config: GitHubClientConfig) => Effect.Effect<{
    events: Queue.Queue<GitHubEvent>
    initialState: RepoState
    tickIntervalSec: number
    initialTick: number
  }, never, Scope.Scope>
}

export class GitHubClientTag extends Context.Tag("GitHubClient")<GitHubClientTag, GitHubClient>() {}

/** Standard GitHub API headers. */
function apiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  }
}

/** Fetch JSON from a URL with error handling. */
const fetchJson = (url: string, headers: Record<string, string>) =>
  Effect.tryPromise({
    try: () =>
      fetch(url, { headers }).then((r) => {
        if (!r.ok) throw new Error(`GitHub API ${r.status}: ${r.statusText}`)
        return r.json()
      }),
    catch: (e) => new Error(`GitHub API failed: ${e}`),
  })

/**
 * Fetch current repo state from GitHub REST API.
 * Makes three parallel calls: issues, PRs, and CI runs.
 */
const fetchRepoState = (owner: string, repo: string, token: string, tick: number) =>
  Effect.gen(function* () {
    const headers = apiHeaders(token)
    const base = `https://api.github.com/repos/${owner}/${repo}`

    // Parallel fetch: issues, PRs, workflow runs
    const [rawIssues, rawPRs, rawRuns] = yield* Effect.all([
      fetchJson(`${base}/issues?state=open&per_page=30`, headers),
      fetchJson(`${base}/pulls?state=open&per_page=30`, headers),
      fetchJson(`${base}/actions/runs?per_page=5&branch=main`, headers),
    ], { concurrency: 3 })

    // Map issues (filter out PRs — GitHub returns PRs in the issues endpoint)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const openIssues: Issue[] = (rawIssues as any[])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((i: any) => !i.pull_request)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((i: any) => ({
        number: i.number,
        title: i.title,
        labels: i.labels?.map((l: { name: string }) => l.name) ?? [],
        author: i.user?.login ?? "unknown",
        createdAt: i.created_at,
        body: (i.body ?? "").slice(0, 500),
      }))

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

    // Derive CI status from most recent workflow run
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runs = (rawRuns as any).workflow_runs ?? []
    let ciStatus: RepoState["ciStatus"] = "unknown"
    if (runs.length > 0) {
      const latest = runs[0]
      if (latest.conclusion === "success") ciStatus = "passing"
      else if (latest.conclusion === "failure") ciStatus = "failing"
      // null conclusion means still running — keep "unknown"
    }

    const state: RepoState = {
      owner,
      repo,
      openIssues,
      openPRs,
      ciStatus,
      recentActivity: [],
      tick,
      timestamp: Date.now(),
    }

    return state
  })

/**
 * GitHub client that polls the REST API for repo state.
 * Uses native fetch (Node 18+) — no gh CLI dependency on host.
 */
export const GitHubClientLive = Layer.succeed(GitHubClientTag, {
  connect: (config: GitHubClientConfig) =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<GitHubEvent>()
      const { owner, repo, token } = config

      // Initial fetch to get real state
      const initialState = yield* fetchRepoState(owner, repo, token, 0).pipe(
        Effect.catchAll((_e) => {
          // Fall back to empty state on initial fetch failure
          return Effect.succeed<RepoState>({
            owner, repo,
            openIssues: [], openPRs: [],
            ciStatus: "unknown",
            recentActivity: [],
            tick: 0,
            timestamp: Date.now(),
          })
        }),
      )

      // Background polling fiber
      let tick = 0
      yield* Effect.gen(function* () {
        tick++
        const state = yield* fetchRepoState(owner, repo, token, tick)
        yield* Queue.offer(events, { type: "poll_update", payload: state })
        yield* Queue.offer(events, { type: "tick", payload: { tick } })
      }).pipe(
        Effect.repeat(Schedule.spaced(config.pollIntervalMs)),
        Effect.catchAll((e) => {
          // Log but don't crash the polling fiber
          return Effect.logWarning(`GitHub poll error: ${e}`)
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
