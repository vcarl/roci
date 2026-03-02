import { Layer } from "effect"
import type { SituationClassifier } from "../../core/situation.js"
import { SituationClassifierTag } from "../../core/situation.js"
import type { GameState, Situation } from "../../../../harness/src/types.js"
import { classifySituation } from "../../../../harness/src/situation/classifier.js"
import { generateBriefing } from "../../../../harness/src/context/briefing.js"

const spaceMoltSituationClassifier: SituationClassifier<GameState, Situation> = {
  classify(state: GameState): Situation {
    const situation = classifySituation(state)
    situation.alerts = [] // Alerts owned by InterruptRegistry
    return situation
  },

  briefing(state: GameState, situation: Situation): string {
    return generateBriefing(state, situation)
  },
}

/** Layer providing the SpaceMolt situation classifier. */
export const SpaceMoltSituationClassifierLive = Layer.succeed(SituationClassifierTag, spaceMoltSituationClassifier)
