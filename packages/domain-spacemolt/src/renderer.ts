import { Layer } from "effect"
import type { StateRenderer } from "@roci/core/core/state-renderer.js"
import { StateRendererTag } from "@roci/core/core/state-renderer.js"
import type { GameState } from "./types.js"
import {
  richSnapshot,
  stateDiff,
} from "./state-renderer.js"

export const spaceMoltStateRenderer: StateRenderer = {
  richSnapshot(state) {
    return richSnapshot(state as GameState)
  },

  stateDiff(before, after) {
    return stateDiff(before, after)
  },

  formatStateBar(metrics) {
    const parts: string[] = []
    if (metrics.situationType) parts.push(`${metrics.situationType}`)
    if (metrics.inCombat) parts.push("COMBAT")
    if (typeof metrics.fuel === "number") parts.push(`fuel:${Math.round(metrics.fuel * 100)}%`)
    if (typeof metrics.hull === "number") parts.push(`hull:${Math.round(metrics.hull * 100)}%`)
    if (metrics.cargoUsed !== undefined) parts.push(`cargo:${metrics.cargoUsed}/${metrics.cargoCapacity}`)
    if (typeof metrics.tick === "number") parts.push(`t:${metrics.tick}`)
    // Age of the last full player+ship refresh — a frozen snapshot shows a
    // climbing age even as ticks advance, making the staleness visible in logs.
    if (typeof metrics.stateAgeSec === "number") parts.push(`age:${metrics.stateAgeSec}s`)
    return parts.join(" ")
  },
}

/** Layer providing the SpaceMolt state renderer. */
export const SpaceMoltStateRendererLive = Layer.succeed(StateRendererTag, spaceMoltStateRenderer)
