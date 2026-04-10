import { Context } from "effect"
import type { DomainState, DomainSituation } from "./domain-types.js"
import type { SituationSummary } from "./limbic/thalamus/situation-classifier.js"
import type { Alert, BrainMode, Plan, PlanStep, StepCompletionResult, StepTiming } from "./types.js"

/** Context for building a planned-action brain prompt. */
export interface PlannedActionBrainPromptContext {
  summary: SituationSummary
  diary: string
  background: string
  values: string
  cycleNumber: number
  maxCycles: number
  softAlerts: Alert[]
  stateDiff?: string
}

export interface PlanPromptContext {
  state: DomainState
  summary: SituationSummary
  diary: string
  background: string
  values: string
  previousFailure?: string
  recentChat?: Array<{ channel: string; sender: string; content: string }>
  stepTimingHistory?: StepTiming[]
  tickIntervalSec: number
  additionalContext?: string
  mode: BrainMode
  investigationReport?: string
  procedureTargets?: string[]
}

export interface InterruptPromptContext {
  state: DomainState
  summary: SituationSummary
  alerts: Alert[]
  currentPlan: Plan | null
  background: string
  mode: BrainMode
  procedureTargets?: string[]
}

export interface EvaluatePromptContext {
  step: PlanStep
  subagentReport: string
  state: DomainState
  stateBefore: Record<string, unknown> | null
  stateDiff: string
  conditionCheck: StepCompletionResult
  ticksConsumed: number
  ticksBudgeted: number
  tickIntervalSec: number
  mode: BrainMode
}

export interface SubagentPromptContext {
  step: PlanStep
  state: DomainState
  situation: DomainSituation
  identity: {
    personality: string
    values: string
    tickIntervalSec: number
  }
  mode: BrainMode
}

/** Context for building the initial task prompt sent to a channel session at startup. */
export interface TaskPromptContext {
  state: DomainState
  summary: SituationSummary
  diary: string
  background: string
  values: string
}

/** Context for a channel tick event payload pushed to a running session. */
export interface ChannelEventContext {
  summary: SituationSummary
  stateDiff?: string
  softAlerts?: Alert[]
  tickNumber: number
}

/**
 * Assembles prompts for the agent session.
 */
export interface PromptBuilder {
  /** Domain-specific system prompt for the subagent container, varying by mode and task. */
  systemPrompt(mode: BrainMode, task: string): string
  /** Build the initial task prompt injected at session start via channel event. */
  taskPrompt(ctx: TaskPromptContext): string
  /** Build a tick/state-update event payload for the channel. */
  channelEvent(ctx: ChannelEventContext): string
}

/**
 * Effect service tag for the prompt builder.
 */
export class PromptBuilderTag extends Context.Tag("PromptBuilder")<PromptBuilderTag, PromptBuilder>() {}
