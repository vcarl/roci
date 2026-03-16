/**
 * Prompt builder for the template todo-list domain.
 *
 * The PromptBuilder assembles all prompts that get sent to the LLM.
 * There are six prompt types:
 *
 *   1. `planPrompt` — given the situation, ask the brain for a plan
 *      (sequence of steps).
 *   2. `interruptPrompt` — given critical alerts, ask the brain to
 *      decide whether to replan.
 *   3. `evaluatePrompt` — after a step completes, ask the brain to
 *      evaluate whether it succeeded.
 *   4. `subagentPrompt` — instructions for the subagent executing
 *      a single step (injected into Claude Code's system prompt).
 *   5. `systemPrompt` — the subagent's system prompt, varying by
 *      mode and task type.
 *   6. `brainPrompt` — the brain's input for a planned-action cycle.
 *
 * ## Design guidance
 *
 * - Keep prompts focused. Each one has a specific job.
 * - Include relevant state but not everything — the LLM's context
 *   window is finite and noisy context hurts quality.
 * - Use the `sections` from SituationSummary — they're already
 *   formatted for LLM consumption.
 * - Template strings work well for prompts. Complex domains might
 *   use Handlebars or Mustache templates loaded from files.
 */

import { Layer } from "effect";
import type { PromptBuilder } from "../core/prompt-builder.js";
import { PromptBuilderTag } from "../core/prompt-builder.js";
import type { TemplateState } from "./types.js";

const templatePromptBuilder: PromptBuilder = {
	/**
	 * Plan prompt — the brain reads this to create a multi-step plan.
	 *
	 * Include:
	 *   - Current situation summary (from sections)
	 *   - Available tasks/skills
	 *   - Previous failure context (if replanning after a failed step)
	 *   - Recent chat messages (if the domain has social features)
	 *   - Character identity (background, values, diary)
	 */
	planPrompt(ctx) {
		const state = ctx.state as TemplateState;
		const sections = ctx.summary.sections.map((s) => `## ${s.heading}\n${s.body}`).join("\n\n");

		const previousFailure = ctx.previousFailure
			? `\n## Previous Plan Failed\n${ctx.previousFailure}\nAdjust your approach to avoid repeating this failure.\n`
			: "";

		return [
			`# Todo Manager — Planning`,
			``,
			`You are managing a todo list. Here is the current situation:`,
			``,
			sections,
			previousFailure,
			`## Your Identity`,
			ctx.background,
			``,
			`## Your Values`,
			ctx.values,
			``,
			`## Recent Diary`,
			ctx.diary,
			``,
			`## Available Tasks`,
			`- complete_item: Mark an item as done after verifying requirements`,
			`- triage: Review and prioritize the backlog`,
			``,
			`Items in the list: ${Object.keys(state.items).length}`,
			`Current focus: ${state.currentFocus ?? "none"}`,
			``,
			`Create a plan with 1-3 steps. Each step should have a task type, goal,`,
			`success condition, and timeout.`,
		].join("\n");
	},

	/**
	 * Interrupt prompt — shown when critical alerts fire.
	 *
	 * The brain decides whether to abort the current plan and replan,
	 * or continue despite the alert.
	 */
	interruptPrompt(ctx) {
		const alertList = ctx.alerts.map((a) => `- [${a.priority}] ${a.message}`).join("\n");

		return [
			`# Interrupt Assessment`,
			``,
			`Critical conditions detected:`,
			alertList,
			``,
			`Current plan: ${ctx.currentPlan ? ctx.currentPlan.steps.map((s) => s.task).join(" → ") : "none"}`,
			``,
			`Should we abort the current plan and replan? Consider:`,
			`- How urgent are these alerts?`,
			`- Can the current plan address them?`,
			`- Would aborting waste significant progress?`,
		].join("\n");
	},

	/**
	 * Evaluate prompt — assess whether a completed step succeeded.
	 *
	 * This runs after the deterministic check (from the Skill) returns
	 * `{ complete: false }`. The LLM makes the final call.
	 */
	evaluatePrompt(ctx) {
		return [
			`# Step Evaluation`,
			``,
			`Task: ${ctx.step.task}`,
			`Goal: ${ctx.step.goal}`,
			`Success condition: ${ctx.step.successCondition}`,
			``,
			`Ticks consumed: ${ctx.ticksConsumed}/${ctx.ticksBudgeted}`,
			``,
			`## Subagent Report`,
			ctx.subagentReport,
			``,
			`## State Changes`,
			ctx.stateDiff,
			``,
			`## Deterministic Check`,
			`Result: ${ctx.conditionCheck.complete ? "PASSED" : "FAILED"}`,
			`Reason: ${ctx.conditionCheck.reason}`,
			``,
			`Did this step achieve its goal? Respond with your assessment.`,
		].join("\n");
	},

	/**
	 * Subagent prompt — injected into the subagent's context when it
	 * runs a step.
	 */
	subagentPrompt(ctx) {
		const state = ctx.state as TemplateState;
		const items = Object.values(state.items);
		const pendingList = items
			.filter((i) => i.status !== "done")
			.map((i) => `- [${i.id}] "${i.title}" (${i.status}, ${i.priority})`)
			.join("\n");

		return [
			`# Task: ${ctx.step.task}`,
			`Goal: ${ctx.step.goal}`,
			``,
			`## Current Items`,
			pendingList || "(no pending items)",
			``,
			`## Instructions`,
			`Follow the goal precisely. Report what you did.`,
		].join("\n");
	},

	/**
	 * System prompt for the subagent container.
	 *
	 * This is the "outer" system prompt that defines the subagent's
	 * overall role. The `subagentPrompt` above is injected as user
	 * context within this frame.
	 */
	systemPrompt(_mode, _task) {
		return [
			`You are a todo-list management assistant. You interact with a`,
			`todo-list system using the available tools.`,
			``,
			`Be precise and efficient. Report your actions clearly.`,
		].join("\n");
	},

	/**
	 * Brain prompt for planned-action cycles.
	 *
	 * This is the per-cycle prompt that the planned-action runner
	 * sends to the brain. It includes the latest situation summary,
	 * diary context, and any soft alerts.
	 */
	brainPrompt(ctx) {
		const sections = ctx.summary.sections.map((s) => `## ${s.heading}\n${s.body}`).join("\n\n");
		const alertsSection =
			ctx.softAlerts.length > 0
				? `\n## Alerts\n${ctx.softAlerts.map((a) => `- [${a.priority}] ${a.message}`).join("\n")}\n`
				: "";

		return [
			`# Cycle ${ctx.cycleNumber}/${ctx.maxCycles}`,
			``,
			sections,
			alertsSection,
			`## Identity`,
			ctx.background,
			``,
			`## Values`,
			ctx.values,
			``,
			`## Recent Diary`,
			ctx.diary,
			``,
			ctx.stateDiff ? `## State Changes Since Last Cycle\n${ctx.stateDiff}\n` : "",
			`What should we focus on this cycle?`,
		].join("\n");
	},
};

/** Layer providing the template prompt builder. */
export const TemplatePromptBuilderLive = Layer.succeed(PromptBuilderTag, templatePromptBuilder);
