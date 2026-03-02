import { Layer } from "effect"
import type { SituationClassifier } from "../../core/situation.js"
import { SituationClassifierTag } from "../../core/situation.js"
import { classifySituation } from "../../game/situation/classifier.js"
import { generateBriefing } from "../../game/context/briefing.js"

const spaceMoltSituationClassifier: SituationClassifier = {
  classify(state) {
    const situation = classifySituation(state)
    situation.alerts = [] // Alerts owned by InterruptRegistry
    return situation
  },

  briefing(state, situation) {
    return generateBriefing(state, situation)
  },
}

/** Layer providing the SpaceMolt situation classifier. */
export const SpaceMoltSituationClassifierLive = Layer.succeed(SituationClassifierTag, spaceMoltSituationClassifier)
