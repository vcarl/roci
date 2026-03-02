import { Layer } from "effect"
import type { StateRenderer } from "../../core/state-renderer.js"
import { StateRendererTag } from "../../core/state-renderer.js"
import { generateBriefing } from "../../game/context/briefing.js"
import {
  snapshot,
  richSnapshot,
  stateDiff,
  logStateBar,
} from "./state-renderer.js"

const spaceMoltStateRenderer: StateRenderer = {
  snapshot(state) {
    return snapshot(state)
  },

  richSnapshot(state) {
    return richSnapshot(state)
  },

  stateDiff(before, after) {
    return stateDiff(before, after)
  },

  renderForPlanning(state, situation) {
    return generateBriefing(state, situation)
  },

  logStateBar(name, state, situation) {
    logStateBar(name, state, situation)
  },
}

/** Layer providing the SpaceMolt state renderer. */
export const SpaceMoltStateRendererLive = Layer.succeed(StateRendererTag, spaceMoltStateRenderer)
