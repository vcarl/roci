/**
 * Interrupt rules for the template todo-list domain.
 *
 * Interrupt rules are declarative conditions that the amygdala
 * evaluates on every state update. When a rule fires, it produces
 * an Alert that may cause the state machine to:
 *
 *   - **Critical**: Kill the current subagent and force immediate
 *     replanning. Use sparingly — only for conditions where
 *     continuing the current task would be actively harmful.
 *
 *   - **High**: Included prominently in the next planning prompt.
 *     The brain will likely change plans on its own.
 *
 *   - **Medium**: Included in the planning prompt as context.
 *     The brain may or may not act on it.
 *
 *   - **Low**: Noted in the planning prompt. Informational only.
 *
 * ## Key fields
 *
 * - `name` — stable identifier, used for suppression and logging.
 * - `condition(state, situation)` — returns true when the rule fires.
 *   Receives opaque types; cast inside.
 * - `message(state, situation)` — human-readable alert text for the
 *   brain. Can include dynamic values from state.
 * - `suggestedAction` — optional hint for the brain.
 * - `suppressWhenTaskIs` — prevents re-triggering if the agent is
 *   already working on the suggested fix. E.g. don't fire "deadline
 *   approaching" if the current step is already "complete_urgent_item".
 */

import { Layer } from "effect";
import type { InterruptRule } from "../core/limbic/amygdala/interrupt.js";
import {
	createInterruptRegistry,
	InterruptRegistryTag,
} from "../core/limbic/amygdala/interrupt.js";
import type { TemplateSituation, TemplateState } from "./types.js";

const interruptRules: ReadonlyArray<InterruptRule> = [
	// ── Critical ─────────────────────────────────────────
	// These trigger immediate replanning. Reserve for truly
	// urgent conditions.
	{
		name: "deadline_imminent",
		priority: "critical",
		condition: (_state, situation) => {
			const sit = situation as TemplateSituation;
			return sit.flags.hasUrgentDeadline;
		},
		message: (state) => {
			const s = state as TemplateState;
			const now = Date.now();
			const urgent = Object.values(s.items).find(
				(i) =>
					i.deadline &&
					i.status !== "done" &&
					new Date(i.deadline).getTime() - now < 60 * 60 * 1000,
			);
			return urgent
				? `URGENT: "${urgent.title}" is due at ${urgent.deadline}! Drop everything and finish it.`
				: "A deadline is imminent — check your items.";
		},
		suggestedAction: "complete_item",
		// Don't interrupt if we're already working on completing an item
		suppressWhenTaskIs: "complete_item",
	},

	// ── High ─────────────────────────────────────────────
	// Important enough to influence the next plan, but not
	// worth killing the current subagent.
	{
		name: "too_many_pending",
		priority: "high",
		condition: (_state, situation) => {
			const sit = situation as TemplateSituation;
			return sit.flags.tooManyPending;
		},
		message: (state) => {
			const s = state as TemplateState;
			const pending = Object.values(s.items).filter((i) => i.status === "pending").length;
			return `You have ${pending} pending items. Consider prioritizing or declining some.`;
		},
		suggestedAction: "triage",
	},

	// ── Medium ───────────────────────────────────────────
	// Helpful context for planning but not urgent.
	{
		name: "blocked_items_exist",
		priority: "medium",
		condition: (state) => {
			const s = state as TemplateState;
			return Object.values(s.items).some((i) => i.status === "blocked");
		},
		message: (state) => {
			const s = state as TemplateState;
			const blocked = Object.values(s.items).filter((i) => i.status === "blocked");
			return `${blocked.length} item(s) are blocked: ${blocked.map((i) => i.title).join(", ")}`;
		},
		suggestedAction: "unblock_item",
	},

	// ── Low ──────────────────────────────────────────────
	// Nice to know, rarely actionable on its own.
	{
		name: "no_focus_set",
		priority: "low",
		condition: (state, situation) => {
			const s = state as TemplateState;
			const sit = situation as TemplateSituation;
			// Only fire if there are pending items but no focus
			return !sit.flags.allDone && s.currentFocus === null;
		},
		message: () => "No item is currently focused. Pick something to work on.",
		suggestedAction: "pick_item",
	},
];

/**
 * Build the interrupt registry from our rules.
 *
 * `createInterruptRegistry` is a factory provided by the core that
 * handles rule evaluation, suppression, sorting by priority, and
 * partitioning into criticals vs soft alerts.
 */
const templateInterruptRegistry = createInterruptRegistry(interruptRules);

/** Layer providing the template interrupt registry. */
export const TemplateInterruptRegistryLive = Layer.succeed(
	InterruptRegistryTag,
	templateInterruptRegistry,
);
