import { Context } from "effect"
import type { DomainState, DomainSituation } from "./domain-types.js"
import type { Alert, Plan, PlanStep, StepCompletionResult, StepTiming } from "./types.js"

export interface PlanPromptContext {
  state: DomainState
  situation: DomainSituation
  briefing: string
  diary: string
  background: string
  values: string
  previousFailure?: string
  recentChat?: Array<{ channel: string; sender: string; content: string }>
  stepTimingHistory?: StepTiming[]
  tickIntervalSec: number
  additionalContext?: string
}

export interface InterruptPromptContext {
  state: DomainState
  situation: DomainSituation
  alerts: Alert[]
  currentPlan: Plan | null
  briefing: string
  background: string
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
}

/**
 * Assembles all prompts for the brain and subagent.
 */
export interface PromptBuilder {
  planPrompt(ctx: PlanPromptContext): string
  interruptPrompt(ctx: InterruptPromptContext): string
  evaluatePrompt(ctx: EvaluatePromptContext): string
  subagentPrompt(ctx: SubagentPromptContext): string
}

/**
 * Effect service tag for the prompt builder.
 */
export class PromptBuilderTag extends Context.Tag("PromptBuilder")<PromptBuilderTag, PromptBuilder>() {}
