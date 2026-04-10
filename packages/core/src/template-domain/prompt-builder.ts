/**
 * Prompt builder for the template todo-list domain.
 *
 * The PromptBuilder assembles prompts that get sent to the LLM.
 * There are three required prompt types:
 *
 *   1. `systemPrompt` — the agent's system prompt, varying by
 *      mode and task type.
 *   2. `taskPrompt` — the initial task injected at session start.
 *   3. `channelEvent` — tick/state-update events pushed to the session.
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
import type { PromptBuilder, TaskPromptContext, ChannelEventContext } from "../core/prompt-builder.js";
import { PromptBuilderTag } from "../core/prompt-builder.js";
import type { TemplateState } from "./types.js";

const templatePromptBuilder: PromptBuilder = {
	/**
	 * System prompt for the agent container.
	 *
	 * This is the "outer" system prompt that defines the agent's
	 * overall role and capabilities.
	 */
	systemPrompt(_mode, _task) {
		return [
			`You are a todo-list management assistant. You interact with a`,
			`todo-list system using the available tools.`,
			``,
			`Be precise and efficient. Report your actions clearly.`,
			`When you have completed your work, call the terminate tool.`,
		].join("\n");
	},

	/**
	 * Task prompt — the initial prompt injected at session start.
	 *
	 * Include:
	 *   - Current situation summary (from sections)
	 *   - Character identity (background, values, diary)
	 *   - Instructions for what the agent should do
	 */
	taskPrompt(ctx: TaskPromptContext) {
		const state = ctx.state as TemplateState;
		const sections = ctx.summary.sections.map((s) => `## ${s.heading}\n${s.body}`).join("\n\n");
		const items = Object.values(state.items);
		const pendingList = items
			.filter((i) => i.status !== "done")
			.map((i) => `- [${i.id}] "${i.title}" (${i.status}, ${i.priority})`)
			.join("\n");

		return [
			`# Todo Manager`,
			``,
			`You are managing a todo list. Here is the current situation:`,
			``,
			sections,
			``,
			`## Current Items`,
			pendingList || "(no pending items)",
			``,
			`## Your Identity`,
			ctx.background,
			``,
			`## Your Values`,
			ctx.values,
			``,
			`## Recent Diary`,
			ctx.diary,
			``,
			`## Instructions`,
			`Review the todo list and take actions to make progress.`,
			`- Mark items as done after completing them`,
			`- Prioritize high-priority items`,
			`- You will receive state updates as the list changes`,
			`- When you have completed your work, call the terminate tool`,
		].join("\n");
	},

	/**
	 * Channel event — a tick/state-update pushed to the running session.
	 *
	 * Keep this concise — it's appended to the session as the agent works.
	 * Include what changed and any alerts that need attention.
	 */
	channelEvent(ctx: ChannelEventContext) {
		const parts: string[] = [`## State Update (tick ${ctx.tickNumber})\n\n${ctx.summary.headline}`];

		if (ctx.stateDiff && ctx.stateDiff.trim()) {
			parts.push(`### Changes\n\n${ctx.stateDiff}`);
		}

		if (ctx.softAlerts && ctx.softAlerts.length > 0) {
			parts.push(`### Alerts\n\n${ctx.softAlerts.map((a) => `- ${a.message}`).join("\n")}`);
		}

		if (ctx.summary.sections.length > 0) {
			parts.push(ctx.summary.sections.map((s) => `### ${s.heading}\n\n${s.body}`).join("\n\n"));
		}

		return parts.join("\n\n");
	},
};

/** Layer providing the template prompt builder. */
export const TemplatePromptBuilderLive = Layer.succeed(PromptBuilderTag, templatePromptBuilder);
