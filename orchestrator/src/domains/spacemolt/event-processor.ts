import { Layer } from "effect"
import { EventProcessorTag, type EventProcessor, type EventResult } from "../../core/limbic/thalamus/event-processor.js"
import type { GameState } from "./types.js"
import type { GameEvent, StateUpdateEvent } from "./ws-types.js"

function handleStateUpdate(payload: StateUpdateEvent["payload"]): EventResult {
  return {
    category: { _tag: "StateChange" },
    stateUpdate: (prev) => {
      const smPrev = prev as GameState
      return {
        ...smPrev,
        player: payload.player,
        ship: payload.ship,
        nearby: payload.nearby,
        inCombat: payload.in_combat,
        tick: payload.tick,
        timestamp: Date.now(),
        travelProgress: payload.travel_progress != null
          ? {
              travel_progress: payload.travel_progress,
              travel_destination: payload.travel_destination ?? "",
              travel_type: payload.travel_type ?? "travel",
              travel_arrival_tick: payload.travel_arrival_tick ?? 0,
            }
          : null,
      }
    },
  }
}

/**
 * SpaceMolt-specific event processor.
 * Translates raw WebSocket GameEvents into state machine operations.
 */
const spaceMoltEventProcessor: EventProcessor = {
  processEvent(event, _currentState) {
    const smEvent = event as GameEvent
    switch (smEvent.type) {
      case "state_update":
        return handleStateUpdate(smEvent.payload)

      case "tick":
        return {
          category: { _tag: "Heartbeat", tick: smEvent.payload.tick },
        }

      case "combat_update": {
        const { payload } = smEvent
        return {
          log: () => {
            // Combat updates are informational — the actual inCombat flag
            // is set by the subsequent state_update event, and the in_combat
            // InterruptRule fires then.
          },
        }
      }

      case "player_died":
        return {
          category: { _tag: "LifecycleReset", reason: "player_died" },
          log: () => {
            // Logging handled by the state machine
          },
        }

      case "chat_message": {
        const { payload } = smEvent
        return {
          context: {
            chatMessages: [{
              channel: payload.channel,
              sender: payload.sender,
              content: payload.content,
            }],
          },
        }
      }

      case "error":
        return {
          log: () => {
            // Logging handled externally
          },
        }

      // Connection lifecycle events — already handled by GameSocket
      case "welcome":
      case "logged_in":
        return {}

      // Suppressed event types (still available via WS event logs)
      case "mining_yield":
      case "poi_arrival":
      case "poi_departure":
      case "skill_level_up":
      case "trade_offer_received":
      case "ok":
        return {}

      default:
        // Unknown event types — no action needed
        return {}
    }
  },
}

/** Layer providing the SpaceMolt event processor as the EventProcessor service. */
export const SpaceMoltEventProcessorLive = Layer.succeed(EventProcessorTag, spaceMoltEventProcessor)
