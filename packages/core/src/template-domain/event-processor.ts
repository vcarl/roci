/**
 * Event processor for the template todo-list domain.
 *
 * The EventProcessor is the "thalamus" — it receives raw events from
 * the domain's event source and translates them into:
 *
 *   1. An EventCategory — tells the state machine what kind of event
 *      this is (heartbeat, state change, or lifecycle reset).
 *   2. A stateUpdate function — a pure function that produces new
 *      state from old state. The state machine calls this to update
 *      its internal state.
 *   3. Optional context — e.g. chat messages that get threaded into
 *      the next planning prompt.
 *   4. Optional log callback — for domain-specific logging.
 *
 * ## Key pattern: casting DomainState/DomainEvent
 *
 * The core types use `unknown` for domain state and events. Inside
 * your event processor, you cast to your concrete types. This is
 * safe because the core never constructs these values — they only
 * come from your domain code.
 */

import { Layer } from "effect";
import {
	type EventProcessor,
	EventProcessorTag,
	type EventResult,
} from "../core/limbic/thalamus/event-processor.js";
import type { TemplateEvent, TemplateState, TodoItem } from "./types.js";

/**
 * Process a single domain event and return instructions for the
 * state machine.
 *
 * The switch statement should be exhaustive — handle every event
 * tag. Return an empty object `{}` for events you want to ignore
 * (the state machine treats missing fields as "no change").
 */
const templateEventProcessor: EventProcessor = {
	processEvent(event, _currentState) {
		// Cast the opaque event to our concrete type.
		// This cast is safe — events only come from our domain's event source.
		const ev = event as TemplateEvent;

		switch (ev._tag) {
			// ── Heartbeat ────────────────────────────────────
			// Ticks drive the plan-act-evaluate loop. The state
			// machine uses these to know time is passing.
			case "Tick":
				return {
					category: { _tag: "Heartbeat", tick: ev.tick },
					stateUpdate: (prev) => {
						const s = prev as TemplateState;
						return { ...s, tick: ev.tick } satisfies TemplateState;
					},
				} satisfies EventResult;

			// ── State changes ────────────────────────────────
			// These update the world state and tell the state
			// machine to re-evaluate the situation.
			case "ItemAdded":
				return {
					category: { _tag: "StateChange" },
					stateUpdate: (prev) => {
						const s = prev as TemplateState;
						return {
							...s,
							items: { ...s.items, [ev.item.id]: ev.item },
							lastUpdated: Date.now(),
						} satisfies TemplateState;
					},
				};

			case "ItemUpdated":
				return {
					category: { _tag: "StateChange" },
					stateUpdate: (prev) => {
						const s = prev as TemplateState;
						const existing = s.items[ev.id];
						if (!existing) return s;

						const updated: TodoItem = { ...existing, ...ev.changes };
						const wasCompleted = existing.status !== "done" && updated.status === "done";
						return {
							...s,
							items: { ...s.items, [ev.id]: updated },
							lastUpdated: Date.now(),
							completedThisSession: wasCompleted
								? s.completedThisSession + 1
								: s.completedThisSession,
						} satisfies TemplateState;
					},
				};

			case "ItemRemoved":
				return {
					category: { _tag: "StateChange" },
					stateUpdate: (prev) => {
						const s = prev as TemplateState;
						const { [ev.id]: _removed, ...remaining } = s.items;
						return {
							...s,
							items: remaining,
							// Clear focus if the removed item was focused
							currentFocus: s.currentFocus === ev.id ? null : s.currentFocus,
							lastUpdated: Date.now(),
						} satisfies TemplateState;
					},
				};

			case "FocusChanged":
				return {
					category: { _tag: "StateChange" },
					stateUpdate: (prev) => {
						const s = prev as TemplateState;
						return {
							...s,
							currentFocus: ev.itemId,
							lastUpdated: Date.now(),
						} satisfies TemplateState;
					},
				};

			// If you add new event types to the union, TypeScript
			// will warn you here if you forget to handle them (as
			// long as you use `never` in the default).
			default: {
				const _exhaustive: never = ev;
				return {};
			}
		}
	},
};

/**
 * Layer providing the template event processor.
 *
 * `Layer.succeed` creates a Layer that immediately provides the
 * service value — no effectful construction needed. Use
 * `Layer.effect` if your processor needs setup (e.g. opening a
 * connection).
 */
export const TemplateEventProcessorLive = Layer.succeed(EventProcessorTag, templateEventProcessor);
