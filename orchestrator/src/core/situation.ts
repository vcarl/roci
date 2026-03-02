import { Context } from "effect"
import type { GameState, Situation } from "../game/types.js"

/**
 * Derives a structured situation from raw domain state.
 */
export interface SituationClassifier {
  /** Derive structured situation (type, flags, alerts) from raw state. */
  classify(state: GameState): Situation
  /** Human-readable briefing for the brain. */
  briefing(state: GameState, situation: Situation): string
}

/**
 * Effect service tag for the situation classifier.
 */
export class SituationClassifierTag extends Context.Tag("SituationClassifier")<SituationClassifierTag, SituationClassifier>() {}
