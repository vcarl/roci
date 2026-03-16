/**
 * State renderer for the template todo-list domain.
 *
 * The StateRenderer transforms domain state into human-readable
 * formats. It serves three audiences:
 *
 *   1. **Logs** — `snapshot()` produces a compact key/value object
 *      logged as JSON after each state update.
 *
 *   2. **Diffs** — `richSnapshot()` produces a more detailed object
 *      that includes data needed for meaningful diffs. `stateDiff()`
 *      compares two rich snapshots and produces a human-readable
 *      string showing what changed.
 *
 *   3. **Console** — `logStateBar()` writes a compact one-line
 *      summary to stderr for live monitoring.
 *
 * ## Design guidance
 *
 * - `snapshot()` should be cheap — it runs on every state update.
 * - `richSnapshot()` can be more expensive — it runs less often
 *   (before and after plan steps) for diff tracking.
 * - `stateDiff()` should be deterministic and produce stable output
 *   for the same inputs.
 * - `logStateBar()` writes to stderr so it doesn't interfere with
 *   structured stdout output.
 */

import { Layer } from "effect";
import type { StateRenderer } from "../core/state-renderer.js";
import { StateRendererTag } from "../core/state-renderer.js";
import type { TemplateState } from "./types.js";

const templateStateRenderer: StateRenderer = {
	/**
	 * Compact snapshot for logging.
	 *
	 * Return a flat object with primitive values. This gets logged
	 * as JSON, so keep it small and readable.
	 */
	snapshot(state) {
		const s = state as TemplateState;
		const items = Object.values(s.items);
		return {
			total: items.length,
			pending: items.filter((i) => i.status === "pending").length,
			inProgress: items.filter((i) => i.status === "in_progress").length,
			done: items.filter((i) => i.status === "done").length,
			blocked: items.filter((i) => i.status === "blocked").length,
			focus: s.currentFocus ?? "none",
			tick: s.tick,
		};
	},

	/**
	 * Rich snapshot for diff tracking.
	 *
	 * Include everything from snapshot() plus data that enables
	 * meaningful diffs — e.g. individual item statuses so we can
	 * detect when specific items change.
	 */
	richSnapshot(state) {
		const s = state as TemplateState;
		const items = Object.values(s.items);
		return {
			...this.snapshot(state),
			// Include per-item status so diffs can show "item X: pending → done"
			itemStatuses: items.map((i) => ({
				id: i.id,
				title: i.title,
				status: i.status,
				priority: i.priority,
			})),
			completedThisSession: s.completedThisSession,
		};
	},

	/**
	 * Human-readable diff between two rich snapshots.
	 *
	 * The state machine calls this to generate the `stateDiff` string
	 * that goes into the evaluate and brain prompts.
	 */
	stateDiff(before, after) {
		if (!before) return "(no before-state captured)";

		const lines: string[] = [];

		// Compare scalar fields
		const scalarKeys = ["total", "pending", "inProgress", "done", "blocked", "focus"] as const;
		for (const key of scalarKeys) {
			const b = before[key];
			const a = after[key];
			if (String(b) !== String(a)) {
				lines.push(`${key}: ${String(b)} -> ${String(a)}`);
			}
		}

		// Compare per-item statuses
		type ItemStatus = { id: string; title: string; status: string; priority: string };
		const beforeItems = (before.itemStatuses ?? []) as ItemStatus[];
		const afterItems = (after.itemStatuses ?? []) as ItemStatus[];
		const beforeMap = new Map(beforeItems.map((i) => [i.id, i]));
		const afterMap = new Map(afterItems.map((i) => [i.id, i]));

		// Items that changed status
		for (const [id, afterItem] of afterMap) {
			const beforeItem = beforeMap.get(id);
			if (!beforeItem) {
				lines.push(`+ "${afterItem.title}" added (${afterItem.status})`);
			} else if (beforeItem.status !== afterItem.status) {
				lines.push(`"${afterItem.title}": ${beforeItem.status} -> ${afterItem.status}`);
			}
		}

		// Items that were removed
		for (const [id, beforeItem] of beforeMap) {
			if (!afterMap.has(id)) {
				lines.push(`- "${beforeItem.title}" removed`);
			}
		}

		return lines.length > 0 ? lines.join("\n") : "(no changes detected)";
	},

	/**
	 * Compact console output line.
	 *
	 * Called per tick for live monitoring. Write to stderr to avoid
	 * interfering with structured output. Use \r to overwrite the
	 * current line for a live-updating dashboard effect.
	 */
	logStateBar(name, metrics) {
		const parts: string[] = [];
		if (metrics.situationType) parts.push(`${metrics.situationType}`);
		if (typeof metrics.pendingCount === "number") parts.push(`pending:${metrics.pendingCount}`);
		if (typeof metrics.completedThisSession === "number")
			parts.push(`done:${metrics.completedThisSession}`);
		if (metrics.hasUrgentDeadline) parts.push("URGENT");
		if (metrics.isOverloaded) parts.push("OVERLOADED");
		process.stderr.write(`\r[${name}] ${parts.join(" | ")}`);
	},
};

/** Layer providing the template state renderer. */
export const TemplateStateRendererLive = Layer.succeed(StateRendererTag, templateStateRenderer);
