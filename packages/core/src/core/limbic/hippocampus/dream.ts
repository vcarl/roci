import * as path from "node:path"
import { Effect } from "effect"
import { CharacterFs, type CharacterConfig } from "../../../services/CharacterFs.js"
import { CharacterLog, logToConsole, logError } from "../../../logging/log-writer.js"
import { eventBase } from "../../../logging/events.js"
import { loadTemplate, renderTemplate } from "../../template.js"
import { runTurn } from "../hypothalamus/process-runner.js"
import type { ModelConfig } from "../../model-config.js"
import { resolveModel } from "../../model-config.js"

/**
 * Unified per-cycle memory compression (every cycle, all domains): CONSOLIDATE the
 * diary (rewrite prior diary + this session's raw per-step appends into coherent
 * narrative entries; may grow), then CULL the diary and SECRETS.md (compress toward
 * the target size, clamped to never grow the file).
 *
 * This is ONE orchestrated operation on ONE runtime. Every turn resolves the single
 * `dreamCompression` role, which defaults to the local conscious-tier mlx model
 * (opencode runtime) — Claude is never invoked in the reflection path. The three
 * turns stay distinct so each keeps its own prompt semantics and never-grows /
 * blank-turn guards.
 */

/**
 * Stable target the cull compresses the diary toward (lines). The cull prompt is
 * instructed to aim at this size; the hard never-grows invariant below guarantees
 * the file can never end up larger than its input regardless of model behavior.
 */
export const DIARY_TARGET_LINES = 150

/**
 * Wall-clock budget for a reflection turn. These run the local reasoning model over
 * the entire diary/secrets and can legitimately take minutes; the prior 120s budget
 * routinely timed out, and a timed-out turn returns empty output that — absent the
 * blank-turn guard below — silently wiped the file. 480s (8min) sits safely under
 * the conscious tier's 600s readiness budget. This is the general reflection budget,
 * shared with the consolidate turn here and with macro/retrospect (which import it).
 */
export const REFLECTION_TURN_TIMEOUT_MS = 480_000

/**
 * Tighter budget for the two CULL turns (diary + secrets). Justified from observed
 * latencies in players/vcarl/logs/events.jsonl (24 cycles): the slowest *productive*
 * cull turn took 319s (diary) / 305s (secrets write); every runaway or stalled turn
 * exceeded ~360s — the 480s stall on 2026-07-03 15:38→15:46 produced zero output, and
 * the 368–389s "successes" were runaway generations the never-grows clamp discarded
 * anyway. 360s preserves every observed productive cull with margin while cutting a
 * stalled cull from 8min to 6min. This is loss-safe: a cull that legitimately runs
 * longer than 360s simply keeps the original file (the fail-open below) and re-culls
 * next cycle — no content is destroyed. Kept separate from REFLECTION_TURN_TIMEOUT_MS
 * so tightening the culls does not silently shrink the macro/retrospect budgets.
 */
export const CULL_TURN_TIMEOUT_MS = 360_000

/**
 * Cap (chars) on each cross-referenced CONTEXT block embedded in a cull prompt — the
 * character background, plus the *other* durable file included only as reference (the
 * secrets when culling the diary, the diary when culling secrets). These inform the
 * compression but are NEVER written back, so truncating them is loss-proof: the file
 * actually being compressed is always passed WHOLE (see the cull prompts below) and
 * its output is guarded by the never-grows clamp. This bounds the prompt so an
 * ever-growing background/diary cannot silently inflate every reflection turn's
 * latency. 4000 mirrors macro's MAX_SYNTHESIS_CHARS; today's inputs (~2.5KB
 * background, ~1.3KB diary) sit under it, so this changes nothing now while capping
 * the tail. NOTE: the file being compressed is deliberately not bounded here — blind
 * truncation of the target would silently delete durable memory. If a target file
 * ever outgrows a single turn, the correct fix is sectioned/chunked compression in
 * code, not truncation (tracked follow-up).
 */
export const REFLECTION_CONTEXT_MAX = 4000

/** Absolute char budget below which compression is skipped — not worth a model turn. Tunable. */
export const DIARY_MIN_COMPRESS_CHARS = 4000

/** Absolute char budget below which compression is skipped — not worth a model turn. Tunable. */
export const SECRETS_MIN_COMPRESS_CHARS = 4000

/** Count lines the same way the diary/secrets sizing is measured elsewhere. */
const lineCount = (s: string) => s.split("\n").length

/**
 * Truncate a reference/context block so a large file can't bloat a cull prompt.
 * Mirrors the truncate idiom in macro.ts / growth-store.ts. Only ever applied to
 * CONTEXT (never the compression target), so it cannot drop durable content.
 */
const truncateContext = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}…`)

/**
 * A reflection turn produced NO usable content if it timed out or returned only
 * empty/whitespace text. Such a turn must be treated as a failure so the existing
 * content is preserved untouched — never overwritten with a blank file. (A timeout
 * does not throw: `runTurn` resolves with `{ output: "", timedOut: true }`, and an
 * empty string defeats the never-grows clamp because `lineCount("") === 1`.)
 */
const isBlankTurn = (r: { output: string; timedOut: boolean }): boolean =>
	r.timedOut || r.output.trim().length === 0

/** Reason string for a blank turn, for failure logging. */
const blankTurnReason = (r: { output: string; timedOut: boolean }): string =>
	r.timedOut ? "turn timed out (no output)" : "turn returned empty output"

export type DreamType = "normal" | "good" | "nightmare"

export interface DreamInput {
	char: CharacterConfig
	containerId: string
	playerName: string
	addDirs?: string[]
	env?: Record<string, string>
	models: ModelConfig
}

export interface DreamOutput {
	diaryConsolidated: boolean
	dreamType: DreamType
	diaryCompressed: boolean
	secretsCompressed: boolean
}

interface DreamTypeSelection {
	dreamType: DreamType
	roll: number
	nightmareThreshold: number
	goodThreshold: number
	secretsLineCount: number
}

function selectDreamType(secretsLineCount: number): DreamTypeSelection {
	const nightmareThreshold = Math.min(secretsLineCount / 6, 15)
	const roll = Math.floor(Math.random() * 100)
	const goodThreshold = 94
	let dreamType: DreamType
	if (roll < nightmareThreshold) dreamType = "nightmare"
	else if (roll >= goodThreshold) dreamType = "good"
	else dreamType = "normal"
	return { dreamType, roll, nightmareThreshold, goodThreshold, secretsLineCount }
}

/** Path to core's shared skill prompts (src/skills, copied to dist/skills). */
const SKILLS_DIR = path.resolve(import.meta.dirname, "../../../skills")
/** Path to the hippocampus dream/cull prompt templates. */
const PROMPTS_DIR = path.resolve(import.meta.dirname, "prompts")

const diaryTemplateFile: Record<DreamType, string> = {
	normal: "dream-diary.md",
	good: "dream-diary-good.md",
	nightmare: "dream-diary-nightmare.md",
}

const secretsTemplateFile: Record<DreamType, string> = {
	normal: "dream-secrets.md",
	good: "dream-secrets-good.md",
	nightmare: "dream-secrets-nightmare.md",
}

/** Map a runTurn result to a discriminated ok/failure, folding blank turns into failures. */
const turnResult = (r: { output: string; timedOut: boolean }) =>
	isBlankTurn(r)
		? { ok: false as const, reason: blankTurnReason(r) }
		: { ok: true as const, text: r.output }

export const dream = {
	name: "dream" as const,
	execute: (input: DreamInput) =>
		Effect.gen(function* () {
			const charFs = yield* CharacterFs
			const log = yield* CharacterLog

			// ONE runtime for the whole operation: the `dreamCompression` role defaults to the
			// local conscious-tier mlx model (opencode). Claude is never invoked here.
			const model = resolveModel(input.models, "dreamCompression", "smart")

			const runReflectionTurn = (prompt: string, timeoutMs: number = REFLECTION_TURN_TIMEOUT_MS) =>
				runTurn({
					containerId: input.containerId,
					playerName: input.playerName,
					char: input.char,
					prompt,
					systemPrompt: "",
					model,
					timeoutMs,
					role: "brain",
					noTools: true,
					addDirs: input.addDirs,
					env: input.env,
				}).pipe(
					Effect.map(turnResult),
					Effect.catchAll((e) => Effect.succeed({ ok: false as const, reason: String(e) })),
				)

			// ── 1. CONSOLIDATE ────────────────────────────────────────
			// Rewrite the current DIARY.md (prior diary + this session's raw per-step
			// appends) into coherent narrative entries. May grow the file; the cull reins
			// it back in below. A failed/blank turn keeps the original diary untouched.
			const preConsolidateDiary = yield* charFs.readDiary(input.char)

			let diaryConsolidated: boolean
			if (preConsolidateDiary.length < DIARY_MIN_COMPRESS_CHARS) {
				// Size gate: a small diary isn't worth a local-model turn. Skip cleanly —
				// leave DIARY.md untouched and let the cull below evaluate the same content.
				diaryConsolidated = false
				yield* log.emit(input.char, {
					...eventBase(input.char.name, "orchestrator", "consolidate"),
					kind: "text",
					text: `dream_diary_consolidate_skipped: below_threshold (${preConsolidateDiary.length} < ${DIARY_MIN_COMPRESS_CHARS})`,
				})
			} else {
				yield* log.emit(input.char, {
					...eventBase(input.char.name, "orchestrator", "consolidate"),
					kind: "text",
					text: "consolidate_start",
				})

				const values = yield* charFs.readValues(input.char)

				const consolidateTemplate = yield* loadTemplate(path.join(SKILLS_DIR, "consolidate.md"))
				const consolidatePrompt = renderTemplate(consolidateTemplate, {
					DIARY: preConsolidateDiary,
					VALUES: values,
				})

				const consolidateTurn = yield* runReflectionTurn(consolidatePrompt)

				if (!consolidateTurn.ok) {
					// A timeout or empty/whitespace output is a FAILED turn — writing it here
					// would destroy the diary. Keep the existing diary exactly as it was and
					// surface the failure as a structured error; the cull still runs below.
					diaryConsolidated = false
					yield* logError(
						input.char.name,
						"hippocampus",
						`consolidate_failed: ${consolidateTurn.reason} — keeping original diary (${lineCount(preConsolidateDiary)} lines)`,
					)
				} else {
					diaryConsolidated = true
					yield* charFs.writeDiary(input.char, consolidateTurn.text)
					yield* log.emit(input.char, {
						...eventBase(input.char.name, "orchestrator", "consolidate"),
						kind: "text",
						text: `consolidate_complete (${lineCount(preConsolidateDiary)} -> ${lineCount(consolidateTurn.text)} lines)`,
					})
				}
			}

			// ── 2. CULL ───────────────────────────────────────────────
			// Re-read so the cull operates on the consolidated diary (or the preserved
			// original if consolidate failed), then compress diary + secrets toward the
			// target, clamped to never grow the file.
			const diary = yield* charFs.readDiary(input.char)
			const secrets = yield* charFs.readSecrets(input.char)
			const background = yield* charFs.readBackground(input.char)

			const secretsLines = secrets.split("\n").filter((l) => l.trim()).length
			const selection = selectDreamType(secretsLines)
			const { dreamType } = selection

			yield* log.emit(input.char, {
				...eventBase(input.char.name, "orchestrator", "dream"),
				kind: "text",
				text: `dream_type_selection: ${dreamType} (roll=${selection.roll}, nightmare<${selection.nightmareThreshold}, good>=${selection.goodThreshold}, secrets=${selection.secretsLineCount})`,
			})

			yield* log.emit(input.char, {
				...eventBase(input.char.name, "orchestrator", "dream"),
				kind: "text",
				text: `dream_start: ${dreamType}`,
			})

			// 2a. Compress diary (cull) — aim at DIARY_TARGET_LINES.
			// Hard invariant: the cull must never produce a larger file than its input.
			// If the model returned more lines than it was given, discard and keep the original.
			let finalDiary: string
			let diaryCompressed: boolean
			if (diary.length < DIARY_MIN_COMPRESS_CHARS) {
				// Size gate: a small (possibly consolidated) diary isn't worth a model turn.
				// Skip cleanly — keep the diary as-is; secrets context below uses it whole.
				finalDiary = diary
				diaryCompressed = false
				yield* log.emit(input.char, {
					...eventBase(input.char.name, "orchestrator", "dream"),
					kind: "text",
					text: `dream_diary_cull_skipped: below_threshold (${diary.length} < ${DIARY_MIN_COMPRESS_CHARS})`,
				})
			} else {
				const diaryPromptRaw = yield* loadTemplate(
					path.join(PROMPTS_DIR, diaryTemplateFile[dreamType]),
				)
				const diaryPrompt = renderTemplate(diaryPromptRaw, {
					TARGET_LINES: String(DIARY_TARGET_LINES),
				})
				// The diary is the compression TARGET here → passed WHOLE (never truncated).
				// background + secrets are reference CONTEXT only → bounded (loss-proof, they
				// are not written back).
				const diaryInput = `${diaryPrompt}\n\n<context name="background">\n${truncateContext(background, REFLECTION_CONTEXT_MAX)}\n</context>\n\n<context name="secrets">\n${truncateContext(secrets, REFLECTION_CONTEXT_MAX)}\n</context>\n\n${diary}`

				// A failed turn (e.g. the local mlx server is down or times out) must NOT abort
				// the cull — fall back to the ORIGINAL diary (the secrets prompt embeds it
				// below) and record the failure without writing. Tighter cull budget.
				const diaryTurn = yield* runReflectionTurn(diaryInput, CULL_TURN_TIMEOUT_MS)

				if (!diaryTurn.ok) {
					finalDiary = diary
					diaryCompressed = false
					// Fail loud (Issue 2): a turn error is a genuine failure site, not the
					// expected never-grows clamp below — surface it as a structured kind:"error"
					// event. Best-effort continuation: keep the original and proceed to secrets.
					yield* logError(
						input.char.name,
						"hippocampus",
						`dream_diary_compression_failed: ${diaryTurn.reason} — keeping original`,
					)
				} else if (lineCount(diaryTurn.text) > lineCount(diary)) {
					finalDiary = diary
					diaryCompressed = false
					yield* logToConsole(
						input.char.name,
						"orchestrator",
						`dream_diary_compression_discarded: cull produced ${lineCount(diaryTurn.text)} lines > ${lineCount(diary)} input lines — keeping original diary`,
						"warn",
					)
				} else {
					finalDiary = diaryTurn.text
					diaryCompressed = true
					yield* charFs.writeDiary(input.char, diaryTurn.text)
					yield* log.emit(input.char, {
						...eventBase(input.char.name, "orchestrator", "dream"),
						kind: "text",
						text: `dream_diary_compressed: ${dreamType} (${diary.length} -> ${diaryTurn.text.length})`,
					})
				}
			}

			// 2b. Compress secrets
			// Same never-grows invariant for SECRETS.md.
			let secretsCompressed: boolean
			if (secrets.length < SECRETS_MIN_COMPRESS_CHARS) {
				// Size gate: a small SECRETS.md isn't worth a model turn. Skip cleanly —
				// leave SECRETS.md untouched.
				secretsCompressed = false
				yield* log.emit(input.char, {
					...eventBase(input.char.name, "orchestrator", "dream"),
					kind: "text",
					text: `dream_secrets_cull_skipped: below_threshold (${secrets.length} < ${SECRETS_MIN_COMPRESS_CHARS})`,
				})
			} else {
				const secretsPrompt = yield* loadTemplate(
					path.join(PROMPTS_DIR, secretsTemplateFile[dreamType]),
				)
				// Secrets is the compression TARGET here → passed WHOLE (never truncated, so no
				// durable secret can be silently dropped from the model's view). background +
				// diary are reference CONTEXT only → bounded (loss-proof).
				const secretsInput = `${secretsPrompt}\n\n<context name="background">\n${truncateContext(background, REFLECTION_CONTEXT_MAX)}\n</context>\n\n<context name="diary">\n${truncateContext(finalDiary, REFLECTION_CONTEXT_MAX)}\n</context>\n\n${secrets}`

				// Symmetric graceful fallback — a diary turn failure does NOT skip this step,
				// and a secrets turn failure keeps the original secrets without writing. Tighter
				// cull budget (this is the turn that stalled 8min for a no-op on 2026-07-03).
				const secretsTurn = yield* runReflectionTurn(secretsInput, CULL_TURN_TIMEOUT_MS)

				if (!secretsTurn.ok) {
					secretsCompressed = false
					// Fail loud (Issue 2): structured kind:"error" for a genuine turn failure,
					// distinct from the never-grows clamp; keep the original secrets.
					yield* logError(
						input.char.name,
						"hippocampus",
						`dream_secrets_compression_failed: ${secretsTurn.reason} — keeping original`,
					)
				} else if (lineCount(secretsTurn.text) > lineCount(secrets)) {
					secretsCompressed = false
					yield* logToConsole(
						input.char.name,
						"orchestrator",
						`dream_secrets_compression_discarded: cull produced ${lineCount(secretsTurn.text)} lines > ${lineCount(secrets)} input lines — keeping original secrets`,
						"warn",
					)
				} else {
					secretsCompressed = true
					yield* charFs.writeSecrets(input.char, secretsTurn.text)
					yield* log.emit(input.char, {
						...eventBase(input.char.name, "orchestrator", "dream"),
						kind: "text",
						text: `dream_secrets_compressed: ${dreamType} (${secrets.length} -> ${secretsTurn.text.length})`,
					})
				}
			}

			yield* log.emit(input.char, {
				...eventBase(input.char.name, "orchestrator", "dream"),
				kind: "text",
				text: `dream_complete: ${dreamType}`,
			})

			return { diaryConsolidated, dreamType, diaryCompressed, secretsCompressed } as DreamOutput
		}),
}
