import { Context } from "effect"
import type { DomainState, DomainSituation } from "./domain-types.js"
import type { SituationSummary } from "./limbic/thalamus/situation-classifier.js"
import type { Alert, BrainMode, PlanStep, StepTiming } from "./types.js"

/** @deprecated Remnant of old brain/body architecture — still used by domain-github prompt helpers. */
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

/** @deprecated Remnant of old brain/body architecture — still used by domain-github prompt helpers. */
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
  /** @deprecated OODA orient+decide now produces task content. Kept for fallback. */
  taskPrompt?(ctx: TaskPromptContext): string
  /** @deprecated OODA orient produces channel event content. Kept for fallback. */
  channelEvent?(ctx: ChannelEventContext): string
}

/**
 * Effect service tag for the prompt builder.
 */
export class PromptBuilderTag extends Context.Tag("PromptBuilder")<PromptBuilderTag, PromptBuilder>() {}
