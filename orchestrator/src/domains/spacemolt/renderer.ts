import { Layer } from "effect"
import type { StateRenderer } from "../../core/state-renderer.js"
import { StateRendererTag } from "../../core/state-renderer.js"
import type { GameState, Situation } from "../../../../harness/src/types.js"
import { generateBriefing } from "../../../../harness/src/context/briefing.js"
import {
  snapshot,
  richSnapshot,
  stateDiff,
  logStateBar,
} from "./state-renderer.js"

const spaceMoltStateRenderer: StateRenderer<GameState, Situation> = {
  snapshot(state: GameState): Record<string, unknown> {
    return snapshot(state)
  },

  richSnapshot(state: GameState): Record<string, unknown> {
    return richSnapshot(state)
  },

  stateDiff(before: Record<string, unknown> | null, after: Record<string, unknown>): string {
    return stateDiff(before, after)
  },

  renderForPlanning(state: GameState, situation: Situation): string {
    return generateBriefing(state, situation)
  },

  logStateBar(name: string, state: GameState, situation: Situation): void {
    logStateBar(name, state, situation)
  },
}

/** Layer providing the SpaceMolt state renderer. */
export const SpaceMoltStateRendererLive = Layer.succeed(StateRendererTag, spaceMoltStateRenderer)
