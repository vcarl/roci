/**
 * Skill definitions for the template todo-list domain.
 *
 * A Skill bundles everything the agent needs to perform a task type:
 *
 *   - `name` — matches the `task` field in PlanStep. The brain
 *     references this when creating plans.
 *   - `description` — shown to the brain during planning so it
 *     knows what skills are available.
 *   - `instructions` — injected into the subagent's system prompt.
 *     This is where you describe HOW to perform the task.
 *   - `checkCompletion` — deterministic success check. If this
 *     returns `{ complete: true }`, the step is done without
 *     needing the LLM evaluator. Return `{ complete: false }` to
 *     fall through to LLM-based evaluation.
 *   - `defaultModel` — "haiku" for simple tasks, "sonnet" for
 *     tasks requiring more reasoning.
 *   - `defaultTimeoutTicks` — how long to wait before declaring
 *     the step stuck.
 *
 * ## When to use deterministic completion checks
 *
 * Use them when success is clearly observable in the state:
 *   - "item marked as done" → check `item.status === "done"`
 *   - "item created" → check if new items exist
 *
 * Don't use them when success is subjective or hard to define:
 *   - "write a good description" → let the LLM evaluator judge
 *   - "triage the backlog" → no clear state signal
 */

import { Layer } from "effect";
import type { Skill, SkillRegistry } from "../core/skill.js";
import { SkillRegistryTag } from "../core/skill.js";
import type { TemplateState } from "./types.js";

const completeItemSkill: Skill = {
	name: "complete_item",
	description: "Mark a todo item as done — verify requirements are met, then update status",
	instructions: [
		"You are completing a todo item. Steps:",
		"1. Read the item's description and requirements",
		"2. Verify that all requirements are satisfied",
		"3. Mark the item as done",
		"4. If requirements aren't met, report what's missing",
	].join("\n"),

	checkCompletion(step, state, _situation) {
		// Parse the goal to extract which item we're completing.
		// In practice, you'd use a more robust parsing strategy.
		const s = state as TemplateState;
		const items = Object.values(s.items);

		// Check if any item mentioned in the goal is now done
		const completedItem = items.find(
			(i) => i.status === "done" && step.goal.toLowerCase().includes(i.title.toLowerCase()),
		);

		if (completedItem) {
			return {
				complete: true,
				reason: `Item "${completedItem.title}" is marked as done`,
				matchedCondition: "item.status === done",
				relevantState: { itemId: completedItem.id, status: completedItem.status },
			};
		}

		return {
			complete: false,
			reason: "Target item is not yet marked as done",
			matchedCondition: null,
			relevantState: {},
		};
	},

	defaultModel: "haiku",
	defaultTimeoutTicks: 5,
};

const triageSkill: Skill = {
	name: "triage",
	description:
		"Review and prioritize pending items — set priorities, identify blockers, defer or decline items",
	instructions: [
		"You are triaging the todo backlog. Steps:",
		"1. Review all pending items",
		"2. Set appropriate priorities (high/medium/low)",
		"3. Identify any blocked items and note why",
		"4. Suggest items to defer or decline if overloaded",
	].join("\n"),

	// Triage has no deterministic completion — it's a judgment call.
	// Fall through to the LLM evaluator.
	checkCompletion() {
		return {
			complete: false,
			reason: "No deterministic check — use your judgment based on state changes",
			matchedCondition: null,
			relevantState: {},
		};
	},

	defaultModel: "sonnet",
	defaultTimeoutTicks: 8,
};

/**
 * Build the skill registry from our skill definitions.
 *
 * The registry provides lookup and formatting helpers used by the
 * state machine and prompt builder.
 */
const skills: ReadonlyArray<Skill> = [completeItemSkill, triageSkill];

const templateSkillRegistry: SkillRegistry = {
	skills,

	getSkill(name) {
		return skills.find((s) => s.name === name);
	},

	/** Formatted list shown to the brain during planning. */
	taskList() {
		return skills.map((s) => `- **${s.name}**: ${s.description}`).join("\n");
	},

	/**
	 * Delegate completion check to the matching skill.
	 * Falls through to a generic "no check" if the skill isn't found.
	 */
	isStepComplete(step, state, situation) {
		const skill = skills.find((s) => s.name === step.task);
		if (skill) return skill.checkCompletion(step, state, situation);
		return {
			complete: false,
			reason: "No deterministic check — use your judgment based on state changes",
			matchedCondition: null,
			relevantState: {},
		};
	},
};

/** Layer providing the template skill registry. */
export const TemplateSkillRegistryLive = Layer.succeed(SkillRegistryTag, templateSkillRegistry);
