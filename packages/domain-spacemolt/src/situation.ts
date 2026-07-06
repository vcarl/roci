import { Layer } from "effect"
import type { SituationClassifier, SituationSummary } from "@roci/core/brain/limbic/thalamus/situation-classifier.js"
import { SituationClassifierTag } from "@roci/core/brain/limbic/thalamus/situation-classifier.js"
import type { GameState } from "./types.js"
import { classifySituation } from "./situation-classifier.js"
import { generateBriefing } from "./briefing.js"

export const spaceMoltSituationClassifier: SituationClassifier = {
  summarize(state) {
    const gameState = state as GameState
    const situation = classifySituation(gameState)
    const briefing = generateBriefing(gameState, situation)

    // Build a headline from situation type
    const headline = `${situation.type} — ${gameState.player.docked_at_base ? "docked" : "in space"}`

    return {
      situation,
      headline,
      sections: [
        { id: "briefing", heading: "Briefing", body: briefing },
      ],
      metrics: {
        situationType: situation.type,
        fuel: gameState.ship.max_fuel > 0 ? gameState.ship.fuel / gameState.ship.max_fuel : 1,
        hull: gameState.ship.max_hull > 0 ? gameState.ship.hull / gameState.ship.max_hull : 1,
        cargoUsed: gameState.ship.cargo_used,
        cargoCapacity: gameState.ship.cargo_capacity,
        inCombat: gameState.inCombat,
        // Staleness instrumentation: current tick + seconds since the last full
        // player+ship snapshot refresh, so a frozen state bar is diagnosable in
        // logs (age climbs without bound if full-state refreshes stop arriving).
        tick: gameState.tick,
        stateAgeSec: Math.max(
          0,
          Math.round((Date.now() - (gameState.lastFullStateAt ?? gameState.timestamp)) / 1000),
        ),
      },
    } satisfies SituationSummary
  },
}

/** Layer providing the SpaceMolt situation classifier. */
export const SpaceMoltSituationClassifierLive = Layer.succeed(SituationClassifierTag, spaceMoltSituationClassifier)
