import { Layer } from "effect"
import type { StateRenderer } from "../../core/state-renderer.js"
import { StateRendererTag } from "../../core/state-renderer.js"
import type { GameState, Situation } from "./types.js"
import { generateBriefing } from "./briefing.js"
import {
  snapshot,
  richSnapshot,
  stateDiff,
  logStateBar,
} from "./state-renderer.js"

const spaceMoltStateRenderer: StateRenderer = {
  snapshot(state) {
    return snapshot(state as GameState)
  },

  richSnapshot(state) {
    return richSnapshot(state as GameState)
  },

  stateDiff(before, after) {
    return stateDiff(before, after)
  },

  renderForPlanning(state, situation) {
    return generateBriefing(state as GameState, situation as Situation)
  },

  logStateBar(name, state, situation) {
    logStateBar(name, state as GameState, situation as Situation)
  },
}

/** Layer providing the SpaceMolt state renderer. */
export const SpaceMoltStateRendererLive = Layer.succeed(StateRendererTag, spaceMoltStateRenderer)
