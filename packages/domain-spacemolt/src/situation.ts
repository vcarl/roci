import { Layer } from "effect"
import type { SituationClassifier, SituationSummary } from "@roci/core/brain/limbic/thalamus/situation-classifier.js"
import { SituationClassifierTag } from "@roci/core/brain/limbic/thalamus/situation-classifier.js"
import type { GameState } from "./types.js"
import { classifySituation } from "./situation-classifier.js"
import { generateBriefing } from "./briefing.js"

/**
 * Age past which the live feed is considered STALE and cognition is warned. ~2
 * full-state refresh intervals (STATE_REFRESH_INTERVAL_MS = 45s in
 * game-socket-impl); beyond this, the WebSocket has almost certainly
 * disconnected and the reconnect supervisor is re-dialing. Kept as a local
 * constant so the pure summarizer stays decoupled from the socket module.
 */
export const STATE_STALE_WARN_MS = 90_000

export const spaceMoltSituationClassifier: SituationClassifier = {
  summarize(state) {
    const gameState = state as GameState
    const situation = classifySituation(gameState)
    const briefing = generateBriefing(gameState, situation)

    // Staleness: seconds since the last genuine full player+ship snapshot. If it
    // exceeds ~2 refresh intervals the live feed has almost certainly dropped and
    // the reconnect supervisor is re-dialing — the state below is FROZEN, not
    // live. Surface that to cognition (metrics + a loud warning atop the briefing)
    // so the brain doesn't reason on stale data as if it were current.
    const stateAgeMs = Date.now() - (gameState.lastFullStateAt ?? gameState.timestamp)
    const stateAgeSec = Math.max(0, Math.round(stateAgeMs / 1000))
    const stale = stateAgeMs > STATE_STALE_WARN_MS

    // Build a headline from situation type
    const baseHeadline = `${situation.type} — ${gameState.player.docked_at_base ? "docked" : "in space"}`
    const headline = stale ? `${baseHeadline} [STALE ${stateAgeSec}s]` : baseHeadline

    const staleWarning = stale
      ? `WARNING: live feed disconnected, data is ${stateAgeSec}s old, reconnecting… — treat the state below as FROZEN, not current.\n\n`
      : ""

    return {
      situation,
      headline,
      sections: [
        { id: "briefing", heading: "Briefing", body: staleWarning + briefing },
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
        // Staleness instrumentation: current tick + seconds since the last full
        // player+ship snapshot refresh, so a frozen state bar is diagnosable in
        // logs (age climbs without bound if full-state refreshes stop arriving).
        tick: gameState.tick,
        stateAgeSec,
        stale,
      },
    } satisfies SituationSummary
  },
}

/** Layer providing the SpaceMolt situation classifier. */
export const SpaceMoltSituationClassifierLive = Layer.succeed(SituationClassifierTag, spaceMoltSituationClassifier)
