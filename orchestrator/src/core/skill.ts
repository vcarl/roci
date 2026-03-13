import { Context } from "effect"
import type { DomainState, DomainSituation } from "./domain-types.js"
import type { PlanStep, StepCompletionResult } from "./types.js"

/**
 * A single agent capability — bundles instructions, completion logic,
 * and defaults so adding a new skill is a single-file operation.
 */
export interface Skill {
  readonly name: string
  readonly description: string
  /** Instructions given to the subagent for this task */
  readonly instructions: string
  /** Deterministic completion check */
  readonly checkCompletion: (step: PlanStep, state: DomainState, situation: DomainSituation) => StepCompletionResult
  /** Default model for this skill */
  readonly defaultModel: "haiku" | "sonnet"
  /** Default timeout in ticks */
  readonly defaultTimeoutTicks: number
}

/**
 * Registry of all skills the agent can perform.
 * Single source of truth for task types, instructions, and completion conditions.
 */
export interface SkillRegistry {
  readonly skills: ReadonlyArray<Skill>
  /** Look up a skill by task name */
  getSkill(name: string): Skill | undefined
  /** Formatted task list for inclusion in planning system prompt */
  taskList(): string
  /** Delegate to the matching skill's checkCompletion */
  isStepComplete(step: PlanStep, state: DomainState, situation: DomainSituation): StepCompletionResult
}

/**
 * Effect service tag for the skill registry.
 */
export class SkillRegistryTag extends Context.Tag("SkillRegistry")<SkillRegistryTag, SkillRegistry>() {}
