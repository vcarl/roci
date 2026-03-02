import { Context } from "effect"
import type { Alert, Plan, PlanStep, StepCompletionResult, StepTiming } from "./types.js"

export interface PlanPromptContext<S, Sit> {
  state: S
  situation: Sit
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

export interface InterruptPromptContext<S, Sit> {
  state: S
  situation: Sit
  alerts: Alert[]
  currentPlan: Plan | null
  briefing: string
  background: string
}

export interface EvaluatePromptContext<S, _Sit> {
  step: PlanStep
  subagentReport: string
  state: S
  stateBefore: Record<string, unknown> | null
  stateDiff: string
  conditionCheck: StepCompletionResult
  ticksConsumed: number
  ticksBudgeted: number
  tickIntervalSec: number
}

export interface SubagentPromptContext<S, Sit> {
  step: PlanStep
  state: S
  situation: Sit
  identity: {
    personality: string
    values: string
    tickIntervalSec: number
  }
}

/**
 * Assembles all prompts for the brain and subagent.
 * Assembles all prompts for the brain and subagent.
 */
export interface PromptBuilder<S = any, Sit = any> {
  planPrompt(ctx: PlanPromptContext<S, Sit>): { system: string; user: string }
  interruptPrompt(ctx: InterruptPromptContext<S, Sit>): { system: string; user: string }
  evaluatePrompt(ctx: EvaluatePromptContext<S, Sit>): { system: string; user: string }
  subagentPrompt(ctx: SubagentPromptContext<S, Sit>): string
}

/**
 * Effect service tag for the prompt builder.
 */
export class PromptBuilderTag extends Context.Tag("PromptBuilder")<
  PromptBuilderTag,
  PromptBuilder
>() {}
