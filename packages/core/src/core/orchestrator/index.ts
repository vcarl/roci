// ── Orchestrator — Lifecycle hooks, planning utilities

export type { BreakConfig, BreakResult } from "./planned-action.js"
export { runBreak, runReflection } from "./planned-action.js"

export type { PlanContext, LifecycleHooks } from "./lifecycle.js"

export type {
  TimingRefs,
} from "./planning/index.js"

export {
  recordStepTiming,
  recordStepOutcome,
} from "./planning/index.js"
