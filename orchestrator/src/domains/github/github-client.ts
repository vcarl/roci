import { Context, Effect, Queue, Schedule, Layer, Scope } from "effect"
import type { RepoState, GitHubEvent } from "./types.js"

export interface GitHubClientConfig {
  readonly owner: string
  readonly repo: string
  readonly pollIntervalMs: number
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

/** Build a stub initial state for development. */
function stubInitialState(owner: string, repo: string): RepoState {
  return {
    owner,
    repo,
    openIssues: [],
    openPRs: [],
    ciStatus: "unknown",
    recentActivity: [],
    tick: 0,
    timestamp: Date.now(),
  }
}

/**
 * Stub GitHub client that produces synthetic poll events.
 * Replace the poll function body with real `gh` CLI calls or GitHub API fetch.
 */
export const GitHubClientLive = Layer.succeed(GitHubClientTag, {
  connect: (config: GitHubClientConfig) =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<GitHubEvent>()
      const initialState = stubInitialState(config.owner, config.repo)

      // Background polling fiber
      let tick = 0
      yield* Effect.gen(function* () {
        tick++
        // TODO: Replace with real GitHub API polling via `gh` CLI or fetch.
        // For now, emit a tick event to keep the event loop alive.
        const state: RepoState = {
          ...initialState,
          tick,
          timestamp: Date.now(),
        }
        yield* Queue.offer(events, { type: "poll_update", payload: state })
        yield* Queue.offer(events, { type: "tick", payload: { tick } })
      }).pipe(
        Effect.repeat(Schedule.spaced(config.pollIntervalMs)),
        Effect.catchAll(() => Effect.void),
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
