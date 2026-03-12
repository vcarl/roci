// ── Planning — Brain functions, cycle management, subagent orchestration

export { brainPlan, brainInterrupt, brainEvaluate } from "./brain.js"

export type { PlanningRefs } from "./planning-cycle.js"
export { maybeRequestPlan } from "./planning-cycle.js"

export type { SubagentRefs, PlanRefs } from "./subagent-manager.js"
export { killSubagent, evaluateCompletedSubagent, checkMidRun, maybeSpawnSubagent } from "./subagent-manager.js"

export type { TimingRefs } from "./step-tracker.js"
export { recordStepTiming, recordStepOutcome } from "./step-tracker.js"
