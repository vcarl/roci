import { Context } from "effect"
import type { DomainState, DomainSituation } from "./domain-types.js"

/**
 * Derives a structured situation from raw domain state.
 */
export interface SituationClassifier {
  /** Derive structured situation (type, flags, alerts) from raw state. */
  classify(state: DomainState): DomainSituation
  /** Human-readable briefing for the brain. */
  briefing(state: DomainState, situation: DomainSituation): string
}

/**
 * Effect service tag for the situation classifier.
 */
export class SituationClassifierTag extends Context.Tag("SituationClassifier")<SituationClassifierTag, SituationClassifier>() {}
