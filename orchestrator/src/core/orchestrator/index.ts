// ── Orchestrator — State machine, lifecycle hooks, planning subsystem

export type { StateMachineConfig } from "./state-machine.js"
export { runStateMachine } from "./state-machine.js"

export type { HypervisorConfig, HypervisorResult, BreakConfig, BreakResult } from "./hypervisor.js"
export { runHypervisor, runBreak, runReflection } from "./hypervisor.js"

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
  runGenericSubagent,
  recordStepTiming,
  recordStepOutcome,
} from "./planning/index.js"

export type {
  PlanningRefs,
  SubagentRefs,
  PlanRefs,
  SubagentInput,
  TimingRefs,
} from "./planning/index.js"
