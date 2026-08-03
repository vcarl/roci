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

    // LIVENESS. This is the character's only signal that its worldview is frozen
    // rather than merely quiet, and it must never be dropped silently.
    //
    // It used to be a wall-clock INFERENCE: the age of the last 45-second
    // get_state poll, which meant a dead socket went unreported for up to ~90
    // seconds and a merely-slow poll looked identical to a dead one. It is now
    // the library's own report, via onDisconnected/onReconnecting/onReconnected
    // → the adapter's connection_state frame → GameState.connected. It flips the
    // moment the socket does.
    const offline = gameState.connected === false

    const baseHeadline = `${situation.type} — ${gameState.player.docked_at_base ? "docked" : "in space"}`
    const headline = offline ? `${baseHeadline} [OFFLINE]` : baseHeadline

    const offlineWarning = offline
      ? "WARNING: live feed disconnected, reconnecting… — treat the state below as FROZEN, not current. It is the last thing you saw before the link dropped, not what is happening now.\n\n"
      : ""

    return {
      situation,
      headline,
      sections: [
        { id: "briefing", heading: "Briefing", body: offlineWarning + briefing },
      ],
      metrics: {
        situationType: situation.type,
        fuel: gameState.ship.max_fuel > 0 ? gameState.ship.fuel / gameState.ship.max_fuel : 1,
        hull: gameState.ship.max_hull > 0 ? gameState.ship.hull / gameState.ship.max_hull : 1,
        cargoUsed: gameState.ship.cargo_used,
        cargoCapacity: gameState.ship.cargo_capacity,
        inCombat: gameState.inCombat,
        // Structured location facts, sourced from the same state the prose
        // briefing already reads (briefing.ts resourceLine/systemPoiSection).
        // Ground truth here lets D3 (applyGroundTruthMetrics) mechanically
        // correct a confabulated `location`/`system` the way it already does
        // for fuel/hull/situationType — see state.ts's D3 docstring, which
        // cites exactly this run-2 confabulation as the motivating bug.
        system: gameState.system?.name ?? gameState.player.current_system,
        location: gameState.poi?.name ?? gameState.player.current_poi,
        docked: gameState.player.docked_at_base != null,
        ...(gameState.player.docked_at_base != null
          ? { dockedAt: gameState.player.docked_at_base }
          : {}),
        // Liveness instrumentation: the current game tick plus whether the socket
        // is up, so a frozen state bar is diagnosable in logs without a stopwatch.
        tick: gameState.tick,
        connected: !offline,
      },
    } satisfies SituationSummary
  },
}

/** Layer providing the SpaceMolt situation classifier. */
export const SpaceMoltSituationClassifierLive = Layer.succeed(SituationClassifierTag, spaceMoltSituationClassifier)
