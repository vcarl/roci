import { Context } from "effect"
import type { BrainMode } from "./types.js"

/**
 * Assembles prompts for the agent session.
 */
export interface PromptBuilder {
  /** Domain-specific system prompt for the subagent container, varying by mode and task. */
  systemPrompt(mode: BrainMode, task: string): string
}

/**
 * Effect service tag for the prompt builder.
 */
export class PromptBuilderTag extends Context.Tag("PromptBuilder")<PromptBuilderTag, PromptBuilder>() {}
