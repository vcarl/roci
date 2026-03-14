import { Layer } from "effect"
import { EventProcessorTag, type EventProcessor, type EventResult } from "@roci/core/core/limbic/thalamus/event-processor.js"
import type { GitHubEvent, GitHubState } from "./types.js"

const gitHubEventProcessor: EventProcessor = {
  processEvent(event, currentState) {
    const ghEvent = event as GitHubEvent
    switch (ghEvent.type) {
      case "poll_update": {
        const prev = currentState as GitHubState
        const { repoIndex, repoState } = ghEvent.payload
        const repos = [...prev.repos]
        // Preserve local state across poll updates (API doesn't know about clones/worktrees)
        repos[repoIndex] = {
          ...repoState,
          clonePath: repos[repoIndex]?.clonePath ?? repoState.clonePath,
          worktreePath: repos[repoIndex]?.worktreePath ?? null,
          currentBranch: repos[repoIndex]?.currentBranch ?? null,
        }
        return {
          category: { _tag: "StateChange" },
          stateUpdate: () => ({
            ...prev,
            repos,
            timestamp: Date.now(),
            authenticatedUser: prev.authenticatedUser,
          }) as unknown,
        } satisfies EventResult
      }

      case "tick":
        return {
          category: { _tag: "Heartbeat", tick: ghEvent.payload.tick },
        } satisfies EventResult

      default:
        return {}
    }
  },
}

/** Layer providing the GitHub event processor. */
export const GitHubEventProcessorLive = Layer.succeed(EventProcessorTag, gitHubEventProcessor)
