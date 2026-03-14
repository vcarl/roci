// ── Orchestrator — State machine, lifecycle hooks, planning subsystem

export type { StateMachineConfig } from "./state-machine.js"
export { runStateMachine } from "./state-machine.js"

export type { PlannedActionConfig, PlannedActionResult, BreakConfig, BreakResult } from "./planned-action.js"
export { runPlannedAction, runBreak, runReflection } from "./planned-action.js"

export type { PlanContext, LifecycleHooks } from "./lifecycle.js"

export {
  brainPlan,
  brainInterrupt,
  brainEvaluate,
  maybeRequestPlan,
  killSubagent,
  evaluateCompletedSubagent,
  checkMidRun,
  maybeSpawnSubagent,
  recordStepTiming,
  recordStepOutcome,
} from "./planning/index.js"

export type {
  BrainContainerContext,
  PlanningRefs,
  SubagentRefs,
  PlanRefs,
  TimingRefs,
} from "./planning/index.js"
