import { Layer } from "effect"
import type { StateRenderer } from "@roci/core/core/state-renderer.js"
import { StateRendererTag } from "@roci/core/core/state-renderer.js"
import type { GameState } from "./types.js"
import {
  richSnapshot,
  stateDiff,
} from "./state-renderer.js"
import { formatEventDigest } from "./event-digest.js"

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
    // Liveness. Printed only when it is BAD — a bar that says nothing about the
    // connection is a healthy one, so the token's presence is the whole signal.
    if (metrics.connected === false) parts.push("OFFLINE")
    return parts.join(" ")
  },

  formatEventDigest(eventType, state) {
    return formatEventDigest(eventType, state as GameState)
  },
}

/** Layer providing the SpaceMolt state renderer. */
export const SpaceMoltStateRendererLive = Layer.succeed(StateRendererTag, spaceMoltStateRenderer)
