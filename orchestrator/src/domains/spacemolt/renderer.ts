import { Layer } from "effect"
import type { StateRenderer } from "../../core/state-renderer.js"
import { StateRendererTag } from "../../core/state-renderer.js"
import type { GameState } from "./types.js"
import {
  snapshot,
  richSnapshot,
  stateDiff,
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

  logStateBar(name, metrics) {
    // Reconstruct minimal state info from metrics for the existing logStateBar function
    // The SpaceMolt logStateBar needs full state, so we just print key metrics
    const parts: string[] = []
    if (metrics.situationType) parts.push(`${metrics.situationType}`)
    if (metrics.inCombat) parts.push("COMBAT")
    if (typeof metrics.fuel === "number") parts.push(`fuel:${Math.round(metrics.fuel * 100)}%`)
    if (typeof metrics.hull === "number") parts.push(`hull:${Math.round(metrics.hull * 100)}%`)
    if (metrics.cargoUsed !== undefined) parts.push(`cargo:${metrics.cargoUsed}/${metrics.cargoCapacity}`)
    process.stderr.write(`\r[${name}] ${parts.join(" ")}`)
  },
}

/** Layer providing the SpaceMolt state renderer. */
export const SpaceMoltStateRendererLive = Layer.succeed(StateRendererTag, spaceMoltStateRenderer)
