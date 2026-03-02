import { Layer } from "effect"
import { EventProcessorTag, type EventProcessor, type EventResult } from "../../core/event-source.js"
import type { GameState } from "../../../../harness/src/types.js"
import type { GameEvent, StateUpdateEvent } from "../../../../harness/src/ws-types.js"

function handleStateUpdate(payload: StateUpdateEvent["payload"]): EventResult<GameState> {
  return {
    stateUpdate: (prev) => ({
      ...prev,
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
    }),
    tick: payload.tick > 0 ? payload.tick : undefined,
    isStateUpdate: true,
  }
}

/**
 * SpaceMolt-specific event processor.
 * Translates raw WebSocket GameEvents into state machine operations.
 */
const spaceMoltEventProcessor: EventProcessor<GameState, GameEvent> = {
  processEvent(event: GameEvent, currentState: GameState): EventResult<GameState> {
    switch (event.type) {
      case "state_update":
        return handleStateUpdate(event.payload)

      case "tick":
        return {
          tick: event.payload.tick,
          isTick: true,
        }

      case "combat_update": {
        const { payload } = event
        return {
          isInterrupt: true,
          accumulatedContext: {
            combatUpdate: payload,
          },
          log: () => {
            // Console logging handled by the state machine's interrupt path
          },
        }
      }

      case "player_died":
        return {
          isReset: true,
          log: () => {
            // Logging handled by the state machine
          },
          accumulatedContext: {
            deathEvent: event.payload,
          },
        }

      case "chat_message": {
        const { payload } = event
        return {
          accumulatedContext: {
            chatMessage: {
              id: payload.id,
              sender_id: payload.sender_id,
              sender: payload.sender,
              channel: payload.channel,
              content: payload.content,
              timestamp: payload.timestamp,
            },
          },
        }
      }

      case "error":
        return {
          log: () => {
            // Logging handled externally
          },
          accumulatedContext: {
            error: event.payload,
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
