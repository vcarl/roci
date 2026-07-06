import { Effect, Queue, Option } from "effect"
import type { CharacterConfig } from "../../services/CharacterFs.js"
import { EventProcessorTag } from "../../brain/limbic/thalamus/event-processor.js"
import { SituationClassifierTag } from "../../brain/limbic/thalamus/situation-classifier.js"
import { InterruptRegistryTag } from "../../brain/limbic/amygdala/interrupt.js"
import type { PlannedActionTempo } from "../../brain/limbic/autonomic/tempo.js"
import { dream } from "../../brain/limbic/hippocampus/dream.js"
import { retrospect } from "../../brain/limbic/hippocampus/retrospect.js"
import { bootstrapSynthesis } from "../../brain/limbic/hippocampus/synthesis-bootstrap.js"
import { macro } from "../../brain/limbic/hippocampus/macro.js"
import type { Alert } from "../types.js"
import { logToConsole, logError, logBehavior } from "../../logging/log-writer.js"
import type { ModelConfig } from "../model-config.js"
import { CharacterFs } from "../../services/CharacterFs.js"
import { LongtermStore, newSinceMark, diaryMark } from "../../brain/limbic/hippocampus/memory/longterm-store.js"
import { finishEpisodeCycle } from "../../logging/episodes.js"

// ── Types ────────────────────────────────────────────────────

export interface BreakConfig {
	char: CharacterConfig
	events: Queue.Queue<unknown>
	initialState: unknown
	tempo: PlannedActionTempo
}

export type BreakResult =
	| { readonly _tag: "Completed"; readonly finalState: unknown }
	| { readonly _tag: "Interrupted"; readonly finalState: unknown; readonly criticals: Alert[] }

// ── runReflection ────────────────────────────────────────────

/**
 * Per-cycle reflection boundary (every cycle, all domains). A single unified
 * compression step (`dream.execute`) CONSOLIDATEs the diary (rewrite prior diary
 * + this session's raw per-step appends into coherent entries; may grow) and then
 * CULLs the diary and secrets (compress toward the target size, clamped to never
 * grow the file). Each compression step (diary consolidate, diary cull, secrets
 * cull) is independently size-gated by an absolute char budget — a step below its
 * threshold is skipped (no model turn, file left unchanged). The whole step runs on
 * the local `dreamCompression` model role — Claude is never invoked in this path.
 */
export const runReflection = (
	char: CharacterConfig,
	containerId: string,
	models: ModelConfig,
	addDirs?: string[],
	env?: Record<string, string>,
) =>
	Effect.gen(function* () {
		// Issue 2 (fail loud, best-effort continuation): a consolidate/dream failure
		// must NOT be a low-visibility info line (logToConsole(..., "error") emits a
		// kind:"system" event that classifies to `info`). Emit a structured
		// kind:"error" event instead — and do NOT halt: a one-cycle reflection skip
		// is recoverable, but the next cycle proceeds with stale, unbounded memory,
		// so the failure has to be loud and diagnosable.
		// Deterministic promotion of RAW episodic entries (spec §5 Route 2 / §1.3),
		// run BEFORE consolidate rewrites the diary and before the destructive cull —
		// this is the rawest text available at this in-scope reflection seam. The loop
		// only appends `\n\n`-separated entries during a session, so the diary left by
		// the previous reflection is a verbatim PREFIX of the current one; a bounded
		// high-water mark (length + sha256 of that previous diary, in the db's meta
		// table) isolates exactly the new appends — no full-history scan, no
		// re-promotion across cycles. BEST-EFFORT: any embed/write failure logs loud
		// (kind:error) and does NOT block consolidate/cull (anti-loss skip).
		yield* Effect.gen(function* () {
			const charFs = yield* CharacterFs
			const store = yield* LongtermStore
			const diary = yield* charFs.readDiary(char)
			const mark = yield* store.readMark(containerId, char)
			const fresh = newSinceMark(diary, mark)
			const n = fresh.length === 0 ? 0 : yield* store.promote(containerId, char, fresh)
			if (n > 0) {
				yield* logToConsole(
					char.name,
					"orchestrator",
					`Reflecting — promoted ${n} raw diary entr${n === 1 ? "y" : "ies"} to long-term memory before cull`,
				)
			}
			yield* logBehavior(char.name, "hippocampus", "reflection", {
				type: "reflection",
				stage: "promote",
				status: "done",
				counts: { promoted: n },
			})
		}).pipe(
			Effect.catchAll((e) =>
				logError(char.name, "hippocampus", `Long-term promotion failed: ${e}`).pipe(
					Effect.catchAll(() => Effect.void),
				),
			),
		)

		// Meso retrospect (spec §4): grade the just-ended cycle's episode streams
		// against the skill index and APPEND skill create/revise/retire proposals to
		// me/growth/proposals.jsonl. Placed AFTER promote (spec:110, "so nothing is
		// lost to the cull") and BEFORE the dream: promote + retrospect both
		// HARVEST the just-ended cycle's raw substrate (raw diary appends / raw
		// episode streams) before the destructive memory rewrites, and this runs
		// BEFORE finishEpisodeCycle rotates the streams at the end. PROPOSES ONLY —
		// never edits a skill or identity file. Best-effort/never-fail, same
		// discipline as every other stage: a retrospect failure must not disturb
		// the dream.
		yield* logBehavior(char.name, "hippocampus", "reflection", {
			type: "reflection",
			stage: "retrospect",
			status: "start",
		})
		yield* retrospect
			.execute({ char, containerId, playerName: char.name, addDirs, env, models })
			.pipe(
				Effect.flatMap((r) =>
					logBehavior(char.name, "hippocampus", "reflection", {
						type: "reflection",
						stage: "retrospect",
						status: "done",
						counts: { proposals: r.proposals },
					}),
				),
				Effect.catchAll((e) =>
					logError(char.name, "hippocampus", `Retrospect failed: ${e}`).pipe(
						Effect.catchAll(() => Effect.void),
					),
				),
			)

		// Issue 2 (fail loud, best-effort continuation): a compression failure must NOT
		// be a low-visibility info line (logToConsole(..., "error") emits a kind:"system"
		// event that classifies to `info`). The unified step already surfaces each
		// internal sub-failure (consolidate / diary cull / secrets cull) as a structured
		// kind:"error" event and keeps the originals; this outer catch is only a
		// last-resort net. Do NOT halt: a one-cycle reflection skip is recoverable, but
		// the next cycle proceeds with stale, unbounded memory, so a failure that escapes
		// here still has to be loud and diagnosable.
		yield* logBehavior(char.name, "hippocampus", "reflection", {
			type: "reflection",
			stage: "dream",
			status: "start",
		})
		yield* logToConsole(
			char.name,
			"orchestrator",
			"Reflecting — consolidating + culling diary (local model)...",
		)
		yield* dream
			.execute({ char, containerId, playerName: char.name, addDirs, env, models })
			.pipe(
				Effect.catchAll((e) =>
					logError(char.name, "hippocampus", `Reflection compression failed: ${e}`).pipe(
						Effect.catchAll(() => Effect.void),
					),
				),
			)

		// Memory-index BOOTSTRAP: the macro growth stage (below) is the only steady-state
		// producer of me/SYNTHESIS.md — the memory index injected into every orient/decide
		// prompt — but it fires only every Nth reflection. Until the first macro cycle
		// lands, a fresh character (or one whose run dies before it) has no index at
		// all. When SYNTHESIS.md is absent or blank, synthesize an initial one ONCE from
		// the character's identity (background/values/diary) so cognition has an index
		// from the first reflection on. Gated on FILE CONTENT (not a counter) → idempotent
		// across sessions, never overwrites a real index. Placed BEFORE macro so that
		// on an Nth cycle macro's rewrite is continuous with (seeded by) the bootstrap.
		// Cheap and best-effort: it skips (no turn) once an index exists, and a failed
		// turn writes nothing — the honest placeholder keeps rendering, retried next cycle.
		yield* logBehavior(char.name, "hippocampus", "reflection", {
			type: "reflection",
			stage: "synthesisBootstrap",
			status: "start",
		})
		yield* bootstrapSynthesis
			.execute({ char, containerId, playerName: char.name, addDirs, env, models })
			.pipe(
				Effect.flatMap((r) =>
					logBehavior(char.name, "hippocampus", "reflection", {
						type: "reflection",
						stage: "synthesisBootstrap",
						status: "done",
						counts: { bootstrapped: r.bootstrapped ? 1 : 0 },
					}),
				),
				Effect.catchAll((e) =>
					logError(char.name, "hippocampus", `Synthesis bootstrap failed: ${e}`).pipe(
						Effect.catchAll(() => Effect.void),
					),
				),
			)

		// Macro "growth stimulation" (spec §4): every Nth reflection cycle (persisted
		// counter, gated inside macro.execute), a tool-less frontier worker adjudicates
		// the accumulated skill proposals, rewrites the bounded SYNTHESIS.md memory index,
		// and appends a character-facing diary growth note. Placed AFTER the dream (so the
		// growth note survives the dream cull) and BEFORE the re-baseline mark (so the note
		// is folded into the marked diary, not re-promoted next cycle). It reads the
		// current-cycle episodes, so it must precede finishEpisodeCycle's rotation.
		// Guardrails are in code (macro cannot write an identity file). Best-effort /
		// never-fail: a macro failure leaves the proposals accumulated for the next macro
		// cycle and disturbs neither the mark nor the rotation below.
		yield* logBehavior(char.name, "hippocampus", "reflection", {
			type: "reflection",
			stage: "macro",
			status: "start",
		})
		yield* macro.execute({ char, containerId, playerName: char.name, addDirs, env, models }).pipe(
			Effect.flatMap((r) =>
				logBehavior(char.name, "hippocampus", "reflection", {
					type: "reflection",
					stage: "macro",
					status: "done",
					counts: {
						ran: r.ran ? 1 : 0,
						accepted: r.accepted,
						rejected: r.rejected,
						synthesized: r.synthesized ? 1 : 0,
						narrated: r.narrated ? 1 : 0,
					},
				}),
			),
			Effect.catchAll((e) =>
				logError(char.name, "hippocampus", `Macro growth stimulation failed: ${e}`).pipe(
					Effect.catchAll(() => Effect.void),
				),
			),
		)

		// Re-baseline the promotion high-water mark to the diary AS LEFT by this
		// reflection (post-consolidate + cull). Next cycle's session appends to this
		// exact text, so marking it now lets the next promotion isolate only the new
		// raw appends. Best-effort: a failure leaves a stale mark, which the prefix
		// check degrades to a whole-diary re-promotion (anti-loss), logged loud.
		yield* Effect.gen(function* () {
			const charFs = yield* CharacterFs
			const store = yield* LongtermStore
			const culled = yield* charFs.readDiary(char)
			yield* store.writeMark(containerId, char, diaryMark(culled))
		}).pipe(
			Effect.catchAll((e) =>
				logError(char.name, "hippocampus", `Long-term mark update failed: ${e}`).pipe(
					Effect.catchAll(() => Effect.void),
				),
			),
		)

		// Close this reflection cycle's episode window and rotate (spec §1):
		// retain the last EPISODE_RETAIN_CYCLES cycles, dropping only whole
		// cycles. finishEpisodeCycle is swallow-and-log — it can never fail
		// reflection, mirroring the best-effort stages above.
		yield* finishEpisodeCycle(char.name)
	})

// ── runBreak ─────────────────────────────────────────────────

export const runBreak = (config: BreakConfig) =>
	Effect.gen(function* () {
		const eventProcessor = yield* EventProcessorTag
		const classifier = yield* SituationClassifierTag
		const interruptRegistry = yield* InterruptRegistryTag

		yield* logToConsole(
			config.char.name,
			"orchestrator",
			`Break phase — resting for ${config.tempo.breakDurationMs / 60_000} minutes (monitoring for critical interrupts)`,
		)

		const startTime = Date.now()
		let currentState = config.initialState

		while (Date.now() - startTime < config.tempo.breakDurationMs) {
			// Drain all pending events without blocking
			let drained = false
			while (!drained) {
				const maybeEvent = yield* Queue.poll(config.events)
				if (Option.isNone(maybeEvent)) {
					drained = true
				} else {
					const event = maybeEvent.value
					const result = yield* Effect.try(() =>
						eventProcessor.processEvent(event, currentState),
					).pipe(
						Effect.catchAll((e) =>
							logError(
								config.char.name,
								"orchestrator",
								`Event processing error during break: ${e}`,
							).pipe(
								Effect.catchAll(() => Effect.void),
								Effect.map(() => ({ category: undefined, stateUpdate: undefined, log: undefined })),
							),
						),
					)

					if (result.stateUpdate) {
						currentState = result.stateUpdate(currentState)
					}

					if (result.log) {
						result.log()
					}

					// Only check for critical interrupts on state changes
					if (result.category?._tag === "StateChange") {
						const summary = classifier.summarize(currentState)
						const criticals = interruptRegistry.criticals(currentState, summary.situation)

						if (criticals.length > 0) {
							yield* logToConsole(
								config.char.name,
								"orchestrator",
								`Critical interrupt during break: ${criticals.map((a) => a.message).join("; ")} — waking up`,
							)
							return {
								_tag: "Interrupted" as const,
								finalState: currentState,
								criticals,
							}
						}
					}
				}
			}

			yield* Effect.sleep(`${config.tempo.breakPollIntervalSec} seconds`)
		}

		const elapsedMin = Math.round((Date.now() - startTime) / 60_000)
		yield* logToConsole(
			config.char.name,
			"orchestrator",
			`Break complete (${elapsedMin} min) — proceeding to reflection`,
		)

		return {
			_tag: "Completed" as const,
			finalState: currentState,
		}
	})
