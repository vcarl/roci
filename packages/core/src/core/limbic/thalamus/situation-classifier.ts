import { Context } from "effect"
import type { DomainState, DomainSituation } from "../../domain-types.js"

export interface SituationSummary {
  situation: DomainSituation
  headline: string
  sections: ReadonlyArray<{
    id: string
    heading: string
    body: string
  }>
  metrics: Record<string, string | number | boolean>
}

/**
 * Derives a structured situation from raw domain state.
 */
export interface SituationClassifier {
  summarize(state: DomainState): SituationSummary
}

/**
 * Effect service tag for the situation classifier.
 */
export class SituationClassifierTag extends Context.Tag("SituationClassifier")<SituationClassifierTag, SituationClassifier>() {}
