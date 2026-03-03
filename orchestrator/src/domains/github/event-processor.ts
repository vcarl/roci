import { Layer } from "effect"
import { EventProcessorTag, type EventProcessor, type EventResult } from "../../core/event-source.js"
import type { GitHubEvent } from "./types.js"

const gitHubEventProcessor: EventProcessor = {
  processEvent(event, _currentState) {
    const ghEvent = event as GitHubEvent
    switch (ghEvent.type) {
      case "poll_update":
        return {
          stateUpdate: (_prev) => ghEvent.payload as unknown,
          isStateUpdate: true,
        } satisfies EventResult

      case "tick":
        return {
          tick: ghEvent.payload.tick,
          isTick: true,
        } satisfies EventResult

      default:
        return {}
    }
  },
}

/** Layer providing the GitHub event processor. */
export const GitHubEventProcessorLive = Layer.succeed(EventProcessorTag, gitHubEventProcessor)
