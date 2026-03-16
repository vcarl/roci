/**
 * Domain types for the template todo-list manager.
 *
 * Every domain defines three core types:
 *   1. State  — the full world state the agent operates on
 *   2. Situation — a derived summary of "what's happening right now"
 *   3. Event — raw events from the domain's event source
 *
 * The core framework types these as `DomainState`, `DomainSituation`,
 * and `DomainEvent` — all `unknown`. Your domain casts to these
 * concrete types inside each service implementation.
 */

// ── Domain State ─────────────────────────────────────────────
//
// This is the single source of truth for the world. The event
// processor updates it; the situation classifier reads it; the
// prompt builder formats it for the LLM.
//
// Keep it serializable (no class instances, no functions) so it
// can be snapshotted for diffs and logged as JSON.

export interface TodoItem {
	/** Unique identifier for the todo. */
	readonly id: string;
	/** Human-readable title. */
	readonly title: string;
	/** Optional longer description. */
	readonly description: string;
	/** Priority level — drives interrupt rules. */
	readonly priority: "high" | "medium" | "low";
	/** Current status. */
	readonly status: "pending" | "in_progress" | "done" | "blocked";
	/** ISO timestamp when the item was created. */
	readonly createdAt: string;
	/** ISO timestamp of the deadline, if any. */
	readonly deadline: string | null;
	/** Tags for categorization. */
	readonly tags: ReadonlyArray<string>;
}

export interface TemplateState {
	/** All todo items, keyed by id for O(1) lookup. */
	readonly items: Record<string, TodoItem>;
	/** The agent's current focus — which item it's working on, if any. */
	readonly currentFocus: string | null;
	/** Monotonically increasing tick counter (incremented by heartbeat events). */
	readonly tick: number;
	/** Timestamp of the last state update. */
	readonly lastUpdated: number;
	/** Number of items completed this session — used for situation classification. */
	readonly completedThisSession: number;
}

// ── Domain Situation ─────────────────────────────────────────
//
// A situation is a *derived* view of state — it answers "what kind
// of moment is this?" rather than "what are all the details?"
//
// The situation classifier computes this, and it flows into the
// prompt builder (for LLM context) and the interrupt rules (for
// threshold checks).

/** High-level classification of what the agent is doing. */
export type TemplateSituationType =
	| "idle" // No items to work on
	| "working" // Actively focused on an item
	| "blocked" // Current focus item is blocked
	| "overloaded" // Too many pending items
	| "wrapping_up"; // Almost done — few items left

export interface TemplateSituationFlags {
	/** True when any item has a deadline within 1 hour. */
	readonly hasUrgentDeadline: boolean;
	/** True when more than 10 items are pending. */
	readonly tooManyPending: boolean;
	/** True when the focused item is blocked. */
	readonly currentItemBlocked: boolean;
	/** True when there are no pending items at all. */
	readonly allDone: boolean;
}

export interface TemplateSituation {
	/** The high-level situation type. */
	readonly type: TemplateSituationType;
	/** Granular flags for interrupt rules and prompt context. */
	readonly flags: TemplateSituationFlags;
}

// ── Domain Events ────────────────────────────────────────────
//
// Events are raw inputs from the domain's event source. In a
// WebSocket game, these come off the wire. In a polling domain
// like GitHub, they come from API responses. For this todo-list
// example, they represent external changes to the todo list.
//
// Use a discriminated union (_tag) so the event processor can
// exhaustively switch on event type.

export type TemplateEvent =
	| { readonly _tag: "Tick"; readonly tick: number }
	| { readonly _tag: "ItemAdded"; readonly item: TodoItem }
	| {
			readonly _tag: "ItemUpdated";
			readonly id: string;
			readonly changes: Partial<Omit<TodoItem, "id">>;
	  }
	| { readonly _tag: "ItemRemoved"; readonly id: string }
	| { readonly _tag: "FocusChanged"; readonly itemId: string | null };
