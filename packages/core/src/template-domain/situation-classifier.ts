/**
 * Situation classifier for the template todo-list domain.
 *
 * The SituationClassifier is the "perception" layer — it takes raw
 * domain state and distills it into a structured summary that the
 * brain and interrupt system can act on.
 *
 * It produces a `SituationSummary` with:
 *   - `situation` — your domain's situation object (cast from DomainSituation)
 *   - `headline` — a one-liner for logs and quick context
 *   - `sections` — rich text sections for the planning prompt
 *   - `metrics` — key/value pairs for the state bar and logging
 *
 * ## Design guidance
 *
 * Keep the classifier pure and deterministic — no side effects, no
 * randomness. It should always produce the same output for the same
 * input state.
 *
 * The `sections` array is particularly important: it's what the LLM
 * reads to understand the current situation. Make it concise but
 * complete.
 */

import { Layer } from "effect";
import type {
	SituationClassifier,
	SituationSummary,
} from "../core/limbic/thalamus/situation-classifier.js";
import { SituationClassifierTag } from "../core/limbic/thalamus/situation-classifier.js";
import type {
	TemplateSituation,
	TemplateSituationFlags,
	TemplateSituationType,
	TemplateState,
} from "./types.js";

/** Deadline threshold — items due within this many ms are "urgent". */
const URGENT_DEADLINE_MS = 60 * 60 * 1000; // 1 hour

/** When pending items exceed this count, the agent is "overloaded". */
const OVERLOAD_THRESHOLD = 10;

/**
 * Classify the current situation from raw state.
 *
 * This is a pure function — no Effect needed, no services required.
 * Complex domains might split this into a separate file (like
 * SpaceMolt's situation-classifier.ts + briefing.ts).
 */
function classifySituation(state: TemplateState): TemplateSituation {
	const items = Object.values(state.items);
	const pending = items.filter((i) => i.status === "pending" || i.status === "in_progress");
	const blocked = items.filter((i) => i.status === "blocked");
	const focusedItem = state.currentFocus ? state.items[state.currentFocus] : null;

	const now = Date.now();
	const hasUrgentDeadline = items.some(
		(i) =>
			i.deadline &&
			i.status !== "done" &&
			new Date(i.deadline).getTime() - now < URGENT_DEADLINE_MS,
	);

	const flags: TemplateSituationFlags = {
		hasUrgentDeadline,
		tooManyPending: pending.length > OVERLOAD_THRESHOLD,
		currentItemBlocked: focusedItem?.status === "blocked",
		allDone: pending.length === 0 && blocked.length === 0,
	};

	// Determine the high-level situation type.
	// Order matters — more specific/urgent situations take priority.
	let type: TemplateSituationType;
	if (flags.allDone) {
		type = "idle";
	} else if (flags.currentItemBlocked) {
		type = "blocked";
	} else if (flags.tooManyPending) {
		type = "overloaded";
	} else if (pending.length <= 2) {
		type = "wrapping_up";
	} else if (state.currentFocus) {
		type = "working";
	} else {
		type = "idle";
	}

	return { type, flags };
}

/**
 * Build the "sections" array that goes into the planning prompt.
 *
 * Each section has:
 *   - `id` — stable identifier (used for section diffing, not shown to LLM)
 *   - `heading` — human-readable heading
 *   - `body` — the content
 *
 * Keep sections focused. The LLM's context window is finite.
 */
function buildSections(
	state: TemplateState,
	situation: TemplateSituation,
): SituationSummary["sections"] {
	const items = Object.values(state.items);
	const pending = items.filter((i) => i.status === "pending" || i.status === "in_progress");
	const blocked = items.filter((i) => i.status === "blocked");

	// Build sections as a mutable array, then return it.
	// SituationSummary["sections"] is ReadonlyArray, so we build
	// with a plain array and let it widen on return.
	const sections: Array<{ id: string; heading: string; body: string }> = [];

	// Summary section — always present
	const summaryLines = [
		`Status: ${situation.type}`,
		`Pending: ${pending.length} | Blocked: ${blocked.length} | Completed this session: ${state.completedThisSession}`,
	];
	if (state.currentFocus) {
		const focused = state.items[state.currentFocus];
		if (focused) {
			summaryLines.push(
				`Current focus: "${focused.title}" (${focused.status}, ${focused.priority} priority)`,
			);
		}
	}
	sections.push({ id: "summary", heading: "Overview", body: summaryLines.join("\n") });

	// Pending items — only if there are any
	if (pending.length > 0) {
		const pendingLines = pending.map((i) => {
			const deadline = i.deadline ? ` — due ${i.deadline}` : "";
			return `- [${i.priority}] ${i.title} (${i.status})${deadline}`;
		});
		sections.push({ id: "pending", heading: "Pending Items", body: pendingLines.join("\n") });
	}

	// Blocked items — highlight these so the LLM can try to unblock them
	if (blocked.length > 0) {
		const blockedLines = blocked.map((i) => `- ${i.title}: ${i.description || "(no details)"}`);
		sections.push({ id: "blocked", heading: "Blocked Items", body: blockedLines.join("\n") });
	}

	return sections;
}

const templateSituationClassifier: SituationClassifier = {
	summarize(state) {
		// Cast the opaque DomainState to our concrete type.
		const s = state as TemplateState;
		const situation = classifySituation(s);

		const items = Object.values(s.items);
		const pending = items.filter((i) => i.status !== "done");

		// Build the headline — shown in logs and as a quick summary.
		const headline = s.currentFocus
			? `${situation.type} — focused on "${s.items[s.currentFocus]?.title ?? "unknown"}"`
			: `${situation.type} — ${pending.length} items pending`;

		return {
			situation,
			headline,
			sections: buildSections(s, situation),
			// Metrics flow into the state bar (logStateBar) and can be
			// used by interrupt rules for quick numeric checks.
			metrics: {
				situationType: situation.type,
				pendingCount: pending.length,
				completedThisSession: s.completedThisSession,
				hasUrgentDeadline: situation.flags.hasUrgentDeadline,
				isOverloaded: situation.flags.tooManyPending,
			},
		} satisfies SituationSummary;
	},
};

/** Layer providing the template situation classifier. */
export const TemplateSituationClassifierLive = Layer.succeed(
	SituationClassifierTag,
	templateSituationClassifier,
);
