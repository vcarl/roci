/**
 * Prompt builder for the template todo-list domain.
 *
 * The PromptBuilder assembles the domain-specific system prompt for
 * the agent container via `systemPrompt(mode, task)`. The prompt can
 * vary by brain mode and task type so different phases of work get
 * appropriately scoped instructions. (Task content and per-tick
 * updates are now produced by the cortex OODA loop, not the builder.)
 *
 * ## Design guidance
 *
 * - Keep prompts focused. Each one has a specific job.
 * - Include relevant state but not everything — the LLM's context
 *   window is finite and noisy context hurts quality.
 * - Template strings work well for prompts. Complex domains might
 *   use Handlebars or Mustache templates loaded from files.
 */

import { Layer } from "effect";
import type { PromptBuilder } from "../core/prompt-builder.js";
import { PromptBuilderTag } from "../core/prompt-builder.js";

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
};

/** Layer providing the template prompt builder. */
export const TemplatePromptBuilderLive = Layer.succeed(PromptBuilderTag, templatePromptBuilder);
