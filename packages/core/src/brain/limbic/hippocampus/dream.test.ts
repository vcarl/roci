import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { CommandExecutor } from "@effect/platform"
import type { UnifiedEvent } from "../../../logging/events.js"

// Mock the model turn so we can script what the "model" returns (or how it fails).
const { runTurnMock } = vi.hoisted(() => ({ runTurnMock: vi.fn() }))
vi.mock("../../../brain/stem/transport/process-runner.js", () => ({
	runTurn: runTurnMock,
}))

import {
	dream,
	DIARY_TARGET_LINES,
	REFLECTION_TURN_TIMEOUT_MS,
	CULL_TURN_TIMEOUT_MS,
	REFLECTION_CONTEXT_MAX,
} from "./dream.js"
import { CharacterFs } from "../../../services/CharacterFs.js"
import { CharacterLog } from "../../../logging/log-writer.js"
import { OAuthToken } from "../../../services/OAuthToken.js"
import { DEFAULT_MODEL_CONFIG } from "../../../core/model-config.js"
import { DEFAULT_CORTEX_MODELS } from "../../../model/handles.js"

const char = { name: "ada", dir: "/work/players/ada/me" }

// Wide lines: each ≥1100 chars so even a 4-line fixture clears the dream size-gate
// thresholds (DIARY/SECRETS_MIN_COMPRESS_CHARS = 4000) and exercises the compression
// path. Padding never changes the line COUNT, so every never-grows / dream-flavor
// assertion (all of which compare line counts) is preserved.
const lines = (n: number, tag: string) =>
	Array.from({ length: n }, (_, i) => `${tag}-${i}`.padEnd(1100, ".")).join("\n")

// Narrow lines that stay UNDER the size-gate thresholds — for the skip tests.
const tinyLines = (n: number, tag: string) =>
	Array.from({ length: n }, (_, i) => `${tag}-${i}`).join("\n")

/** Stateful CharacterFs fake: reads reflect prior writes. */
function makeFs(initial: { diary: string; secrets: string; background?: string }) {
	const state = { background: "BACKGROUND", ...initial }
	const diaryWrites: string[] = []
	const secretsWrites: string[] = []
	const layer = Layer.succeed(
		CharacterFs,
		CharacterFs.of({
			readDiary: () => Effect.succeed(state.diary),
			writeDiary: (_c, content) =>
				Effect.sync(() => {
					state.diary = content
					diaryWrites.push(content)
				}),
			readSecrets: () => Effect.succeed(state.secrets),
			writeSecrets: (_c, content) =>
				Effect.sync(() => {
					state.secrets = content
					secretsWrites.push(content)
				}),
			readCredentials: () => Effect.succeed({ username: "", password: "" }),
			readBackground: () => Effect.succeed(state.background),
			readValues: () => Effect.succeed("VALUES"),
			readPalette: () => Effect.succeed(""),
			readDrives: () => Effect.succeed(""),
			characterExists: () => Effect.succeed(true),
			listSkills: () => Effect.succeed([]),
			readSkill: () => Effect.succeed(null),
			writeSkill: () => Effect.void,
			readSynthesis: () => Effect.succeed(""),
			writeSynthesis: () => Effect.void,
			deleteSkill: () => Effect.void,
		}),
	)
	return { layer, state, diaryWrites, secretsWrites }
}

function makeLog() {
	const events: UnifiedEvent[] = []
	const layer = Layer.succeed(
		CharacterLog,
		CharacterLog.of({
			emit: (_c, e) =>
				Effect.sync(() => {
					events.push(e)
				}),
		}),
	)
	return { layer, events }
}

const StubCommandExecutor = Layer.succeed(CommandExecutor.CommandExecutor, {
	start: () => {
		throw new Error("stub")
	},
} as unknown as CommandExecutor.CommandExecutor)
const StubOAuthToken = Layer.succeed(
	OAuthToken,
	OAuthToken.of({
		getToken: Effect.succeed({ token: "stub", version: 0 }),
		validateInContainer: () => Effect.succeed(true),
	}),
)

beforeEach(() => {
	runTurnMock.mockReset()
	// Deterministic dream type = normal (roll 50; nightmare<~1, good>=94).
	vi.spyOn(Math, "random").mockReturnValue(0.5)
})
afterEach(() => {
	vi.restoreAllMocks()
})

const run = (eff: Effect.Effect<unknown, unknown, never>) => Effect.runPromise(eff)

const provide = (fs: ReturnType<typeof makeFs>, log: ReturnType<typeof makeLog>) =>
	Layer.mergeAll(fs.layer, log.layer, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)

/**
 * The unified dream step fires exactly three model turns per cycle:
 *   1 = consolidate, 2 = diary cull, 3 = secrets cull.
 */
describe("dream — single-runtime local model", () => {
	it("runs every turn (consolidate + both culls) on the local dream-compression model — never a claude tier", async () => {
		const fs = makeFs({ diary: lines(40, "orig"), secrets: lines(6, "sec") })
		const log = makeLog()
		const modelsUsed: string[] = []
		let call = 0
		runTurnMock.mockImplementation((config: { model: string }) => {
			modelsUsed.push(config.model)
			call++
			return Effect.succeed({ output: lines(5, `t${call}`), timedOut: false, durationMs: 1 })
		})

		await run(
			dream
				.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
				.pipe(Effect.provide(provide(fs, log))) as Effect.Effect<unknown, unknown, never>,
		)

		// The conscious `-m` label is `local/<real-model-id>` (consciousModelLabel). Computed
		// inline here rather than imported from cortex/opencode-config so this limbic test
		// holds no limbic→cortex edge (the invariant this refactor enforces).
		const local = `local/${DEFAULT_CORTEX_MODELS.conscious.model}`
		expect(call).toBe(3)
		expect(modelsUsed).toEqual([local, local, local])
		for (const m of modelsUsed) expect(["haiku", "sonnet", "opus"]).not.toContain(m)
	})
})

describe("dream — consolidate pass", () => {
	it("writes the consolidated diary FIRST on a successful turn", async () => {
		const fs = makeFs({ diary: lines(20, "orig"), secrets: lines(4, "sec") })
		const log = makeLog()
		const rewritten = lines(25, "narrative")
		let call = 0
		runTurnMock.mockImplementation(() => {
			call++
			if (call === 1) return Effect.succeed({ output: rewritten, timedOut: false, durationMs: 1 })
			return Effect.succeed({ output: lines(5, "culled"), timedOut: false, durationMs: 1 })
		})

		const out = await run(
			dream
				.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
				.pipe(Effect.provide(provide(fs, log))) as Effect.Effect<unknown, unknown, never>,
		)

		// Consolidate wrote before the cull.
		expect(fs.diaryWrites[0]).toBe(rewritten)
		expect((out as { diaryConsolidated: boolean }).diaryConsolidated).toBe(true)
		const completed = log.events.some(
			(e) => e.kind === "text" && /consolidate_complete/.test((e as { text?: string }).text ?? ""),
		)
		expect(completed).toBe(true)
	})

	it("keeps the original diary and logs a structured error when the consolidate turn times out; the cull still runs", async () => {
		const fs = makeFs({ diary: lines(76, "orig"), secrets: lines(4, "sec") })
		const log = makeLog()
		const prompts: string[] = []
		let call = 0
		runTurnMock.mockImplementation((config: { prompt: string }) => {
			prompts.push(config.prompt)
			call++
			if (call === 1) return Effect.succeed({ output: "", timedOut: true, durationMs: 1 })
			return Effect.succeed({ output: lines(5, "culled"), timedOut: false, durationMs: 1 })
		})

		const out = await run(
			dream
				.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
				.pipe(Effect.provide(provide(fs, log))) as Effect.Effect<unknown, unknown, never>,
		)

		// The empty/timed-out consolidate output never wrote — proven by the cull turn
		// (call 2) seeing the ORIGINAL diary in its prompt.
		expect((out as { diaryConsolidated: boolean }).diaryConsolidated).toBe(false)
		expect(prompts[1]).toContain("orig-0")
		// No false "consolidate_complete" success line.
		const falselyComplete = log.events.some(
			(e) => e.kind === "text" && /consolidate_complete/.test((e as { text?: string }).text ?? ""),
		)
		expect(falselyComplete).toBe(false)
		// The failure is surfaced as a structured error.
		const failed = log.events.some(
			(e) => e.kind === "error" && /consolidat/i.test((e as { message?: string }).message ?? ""),
		)
		expect(failed).toBe(true)
		// The cull still ran after the consolidate failure (best-effort continuation).
		expect(call).toBe(3)
	})

	it("keeps the original diary when the consolidate turn returns whitespace-only output", async () => {
		const fs = makeFs({ diary: lines(60, "orig"), secrets: lines(4, "sec") })
		const log = makeLog()
		let call = 0
		runTurnMock.mockImplementation(() => {
			call++
			if (call === 1) return Effect.succeed({ output: "  \n\t\n ", timedOut: false, durationMs: 1 })
			return Effect.succeed({ output: lines(5, "culled"), timedOut: false, durationMs: 1 })
		})

		const out = await run(
			dream
				.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
				.pipe(Effect.provide(provide(fs, log))) as Effect.Effect<unknown, unknown, never>,
		)

		expect((out as { diaryConsolidated: boolean }).diaryConsolidated).toBe(false)
	})
})

describe("dream — cull never-grows invariant", () => {
	it("discards a compressed diary LONGER than the input and keeps the (consolidated) diary, logging a warning", async () => {
		const fs = makeFs({ diary: lines(10, "orig"), secrets: lines(5, "sec") })
		const log = makeLog()
		const consolidated = lines(10, "consol")
		const longer = lines(100, "bloat")

		let call = 0
		runTurnMock.mockImplementation(() => {
			call++
			// 1 = consolidate, 2 = diary cull (LONGER — discarded), 3 = secrets cull
			if (call === 1)
				return Effect.succeed({ output: consolidated, timedOut: false, durationMs: 1 })
			if (call === 2) return Effect.succeed({ output: longer, timedOut: false, durationMs: 1 })
			return Effect.succeed({ output: lines(2, "sec"), timedOut: false, durationMs: 1 })
		})

		const out = await run(
			dream
				.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
				.pipe(Effect.provide(provide(fs, log))) as Effect.Effect<unknown, unknown, never>,
		)

		expect(fs.diaryWrites).not.toContain(longer)
		// The consolidated diary is preserved (never overwritten by the bloated cull).
		expect(fs.state.diary).toBe(consolidated)
		expect((out as { diaryCompressed: boolean }).diaryCompressed).toBe(false)
		const warned = log.events.some(
			(e) => e.level === "warn" && e.kind === "system" && /diar/i.test(e.message),
		)
		expect(warned).toBe(true)
	})

	it("applies the never-grows invariant to SECRETS.md too", async () => {
		const fs = makeFs({ diary: lines(30, "orig"), secrets: lines(4, "sec") })
		const log = makeLog()
		const longerSecrets = lines(80, "secbloat")

		let call = 0
		runTurnMock.mockImplementation(() => {
			call++
			// 1 = consolidate, 2 = diary cull (shorter, accepted), 3 = secrets cull (LONGER — discarded)
			if (call === 1)
				return Effect.succeed({ output: lines(20, "consol"), timedOut: false, durationMs: 1 })
			if (call === 2)
				return Effect.succeed({ output: lines(5, "culled"), timedOut: false, durationMs: 1 })
			return Effect.succeed({ output: longerSecrets, timedOut: false, durationMs: 1 })
		})

		const out = await run(
			dream
				.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
				.pipe(Effect.provide(provide(fs, log))) as Effect.Effect<unknown, unknown, never>,
		)

		expect(fs.secretsWrites).not.toContain(longerSecrets)
		expect(fs.state.secrets).toBe(lines(4, "sec"))
		expect((out as { secretsCompressed: boolean }).secretsCompressed).toBe(false)
		const warned = log.events.some(
			(e) => e.level === "warn" && e.kind === "system" && /secret/i.test(e.message),
		)
		expect(warned).toBe(true)
	})
})

describe("dream — cull failed/timed-out turns preserve originals", () => {
	it("keeps the (consolidated) diary EXACTLY when the diary cull turn times out (empty output)", async () => {
		const fs = makeFs({ diary: lines(98, "orig"), secrets: lines(5, "sec") })
		const log = makeLog()
		const consolidated = lines(90, "consol")

		let call = 0
		runTurnMock.mockImplementation(() => {
			call++
			if (call === 1)
				return Effect.succeed({ output: consolidated, timedOut: false, durationMs: 1 })
			if (call === 2) return Effect.succeed({ output: "", timedOut: true, durationMs: 1 })
			return Effect.succeed({ output: lines(2, "sec"), timedOut: false, durationMs: 1 })
		})

		const out = await run(
			dream
				.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
				.pipe(Effect.provide(provide(fs, log))) as Effect.Effect<unknown, unknown, never>,
		)

		// The empty cull output never overwrote the consolidated diary.
		expect(fs.state.diary).toBe(consolidated)
		expect((out as { diaryCompressed: boolean }).diaryCompressed).toBe(false)
		const failed = log.events.some(
			(e) => e.kind === "error" && /diar/i.test((e as { message?: string }).message ?? ""),
		)
		expect(failed).toBe(true)
		const falselyCompressed = log.events.some(
			(e) =>
				e.kind === "text" && /dream_diary_compressed/.test((e as { text?: string }).text ?? ""),
		)
		expect(falselyCompressed).toBe(false)
	})

	it("keeps the original secrets EXACTLY when the secrets cull turn times out (empty output)", async () => {
		const fs = makeFs({ diary: lines(30, "orig"), secrets: lines(40, "sec") })
		const log = makeLog()

		let call = 0
		runTurnMock.mockImplementation(() => {
			call++
			if (call === 1)
				return Effect.succeed({ output: lines(20, "consol"), timedOut: false, durationMs: 1 })
			if (call === 2)
				return Effect.succeed({ output: lines(8, "culled"), timedOut: false, durationMs: 1 })
			return Effect.succeed({ output: "", timedOut: true, durationMs: 1 })
		})

		const out = await run(
			dream
				.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
				.pipe(Effect.provide(provide(fs, log))) as Effect.Effect<unknown, unknown, never>,
		)

		expect(fs.secretsWrites).toHaveLength(0)
		expect(fs.state.secrets).toBe(lines(40, "sec"))
		expect((out as { secretsCompressed: boolean }).secretsCompressed).toBe(false)
		const failed = log.events.some(
			(e) => e.kind === "error" && /secret/i.test((e as { message?: string }).message ?? ""),
		)
		expect(failed).toBe(true)
	})

	it("treats a whitespace-only diary cull output as a failure and keeps the (consolidated) diary", async () => {
		const fs = makeFs({ diary: lines(50, "orig"), secrets: lines(5, "sec") })
		const log = makeLog()
		const consolidated = lines(45, "consol")

		let call = 0
		runTurnMock.mockImplementation(() => {
			call++
			if (call === 1)
				return Effect.succeed({ output: consolidated, timedOut: false, durationMs: 1 })
			if (call === 2)
				return Effect.succeed({ output: "   \n  \n\t", timedOut: false, durationMs: 1 })
			return Effect.succeed({ output: lines(2, "sec"), timedOut: false, durationMs: 1 })
		})

		const out = await run(
			dream
				.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
				.pipe(Effect.provide(provide(fs, log))) as Effect.Effect<unknown, unknown, never>,
		)

		expect(fs.state.diary).toBe(consolidated)
		expect((out as { diaryCompressed: boolean }).diaryCompressed).toBe(false)
	})
})

describe("dream — target compression + dream flavor", () => {
	it("writes the compressed diary when it is shorter than the (consolidated) diary", async () => {
		const fs = makeFs({ diary: lines(40, "orig"), secrets: lines(6, "sec") })
		const log = makeLog()
		const culled = lines(8, "culled")

		let call = 0
		runTurnMock.mockImplementation(() => {
			call++
			if (call === 1)
				return Effect.succeed({ output: lines(35, "consol"), timedOut: false, durationMs: 1 })
			if (call === 2) return Effect.succeed({ output: culled, timedOut: false, durationMs: 1 })
			return Effect.succeed({ output: lines(3, "sec"), timedOut: false, durationMs: 1 })
		})

		const out = await run(
			dream
				.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
				.pipe(Effect.provide(provide(fs, log))) as Effect.Effect<unknown, unknown, never>,
		)

		expect(fs.diaryWrites).toContain(culled)
		expect(fs.state.diary).toBe(culled)
		expect((out as { diaryCompressed: boolean }).diaryCompressed).toBe(true)
	})

	it("exposes DIARY_TARGET_LINES = 150 and renders it into the diary cull prompt (turn 2)", async () => {
		expect(DIARY_TARGET_LINES).toBe(150)

		const fs = makeFs({ diary: lines(40, "orig"), secrets: lines(6, "sec") })
		const log = makeLog()
		const prompts: string[] = []
		runTurnMock.mockImplementation((config: { prompt: string }) => {
			prompts.push(config.prompt)
			return Effect.succeed({ output: lines(5, "culled"), timedOut: false, durationMs: 1 })
		})

		await run(
			dream
				.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
				.pipe(Effect.provide(provide(fs, log))) as Effect.Effect<unknown, unknown, never>,
		)

		// Turn 1 = consolidate, turn 2 = diary cull — the target line count is in the cull prompt.
		expect(prompts[1]).toContain(String(DIARY_TARGET_LINES))
	})

	it("gives each cull turn the tighter CULL_TURN_TIMEOUT_MS while consolidate keeps the reflection budget", async () => {
		// Documented budgets: 360s for the two culls, 480s for the general reflection turn.
		expect(CULL_TURN_TIMEOUT_MS).toBe(360_000)
		expect(REFLECTION_TURN_TIMEOUT_MS).toBe(480_000)
		expect(CULL_TURN_TIMEOUT_MS).toBeLessThan(REFLECTION_TURN_TIMEOUT_MS)

		const fs = makeFs({ diary: lines(40, "orig"), secrets: lines(6, "sec") })
		const log = makeLog()
		const timeouts: number[] = []
		runTurnMock.mockImplementation((config: { timeoutMs: number }) => {
			timeouts.push(config.timeoutMs)
			return Effect.succeed({ output: lines(5, "culled"), timedOut: false, durationMs: 1 })
		})

		await run(
			dream
				.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
				.pipe(Effect.provide(provide(fs, log))) as Effect.Effect<unknown, unknown, never>,
		)

		// Turn 1 = consolidate (reflection budget), turn 2 = diary cull, turn 3 = secrets cull.
		expect(timeouts).toEqual([
			REFLECTION_TURN_TIMEOUT_MS,
			CULL_TURN_TIMEOUT_MS,
			CULL_TURN_TIMEOUT_MS,
		])
	})

	it("bounds oversized reference CONTEXT (background/diary) in the cull prompts but passes the compression TARGET whole", async () => {
		// Background far exceeds the cap; the secrets file (the secrets-cull TARGET) also
		// exceeds the cap and MUST survive whole so no durable secret is dropped.
		const bigBackground = lines(2000, "bgline") // ~14KB, >> REFLECTION_CONTEXT_MAX
		const bigSecrets = lines(1000, "secretline") // ~11KB, >> REFLECTION_CONTEXT_MAX
		expect(bigBackground.length).toBeGreaterThan(REFLECTION_CONTEXT_MAX)
		expect(bigSecrets.length).toBeGreaterThan(REFLECTION_CONTEXT_MAX)

		const fs = makeFs({ diary: lines(30, "orig"), secrets: bigSecrets, background: bigBackground })
		const log = makeLog()
		const prompts: string[] = []
		let call = 0
		runTurnMock.mockImplementation((config: { prompt: string }) => {
			prompts.push(config.prompt)
			call++
			// Consolidate (turn 1) must leave the diary ABOVE the size gate so the diary
			// cull still fires (turn 2) and the secrets cull is turn 3 (prompts[2]).
			if (call === 1)
				return Effect.succeed({ output: lines(30, "consol"), timedOut: false, durationMs: 1 })
			// Return a short cull so the never-grows clamp accepts it.
			return Effect.succeed({ output: lines(3, "culled"), timedOut: false, durationMs: 1 })
		})

		await run(
			dream
				.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
				.pipe(Effect.provide(provide(fs, log))) as Effect.Effect<unknown, unknown, never>,
		)

		// The secrets-cull prompt (turn 3) embeds background as CONTEXT — truncated (head
		// kept, tail dropped, ellipsis marker present).
		const secretsCullPrompt = prompts[2]
		expect(secretsCullPrompt).toContain("bgline-0")
		expect(secretsCullPrompt).not.toContain("bgline-1999")
		expect(secretsCullPrompt).toContain("…")
		// ...but the secrets file itself is the TARGET → passed WHOLE, first AND last line
		// present, so no secret can be silently deleted by the bound.
		expect(secretsCullPrompt).toContain("secretline-0")
		expect(secretsCullPrompt).toContain("secretline-999")
	})

	it("selects and records the nightmare dream flavor when the roll is low", async () => {
		// 20 non-blank secret lines → nightmareThreshold = min(20/6, 15) ≈ 3.33.
		// roll = floor(0.0 * 100) = 0 < 3.33 → nightmare.
		vi.spyOn(Math, "random").mockReturnValue(0)
		const fs = makeFs({ diary: lines(30, "orig"), secrets: lines(20, "sec") })
		const log = makeLog()
		runTurnMock.mockImplementation(() =>
			Effect.succeed({ output: lines(3, "x"), timedOut: false, durationMs: 1 }),
		)

		const out = await run(
			dream
				.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
				.pipe(Effect.provide(provide(fs, log))) as Effect.Effect<unknown, unknown, never>,
		)

		expect((out as { dreamType: string }).dreamType).toBe("nightmare")
		const selection = log.events.some(
			(e) =>
				e.kind === "text" &&
				/dream_type_selection: nightmare/.test((e as { text?: string }).text ?? ""),
		)
		expect(selection).toBe(true)
	})
})

describe("dream — per-step size gate (absolute char budget)", () => {
	it("skips BOTH diary steps (consolidate + cull) with no model call when DIARY.md is below the threshold", async () => {
		// Diary and secrets are both tiny (well under 4000 chars) → every compression
		// step is gated off, so the local model is never invoked and nothing is rewritten.
		const smallDiary = tinyLines(20, "orig")
		const smallSecrets = tinyLines(6, "sec")
		expect(smallDiary.length).toBeLessThan(4000)
		expect(smallSecrets.length).toBeLessThan(4000)
		const fs = makeFs({ diary: smallDiary, secrets: smallSecrets })
		const log = makeLog()
		runTurnMock.mockImplementation(() =>
			Effect.succeed({ output: tinyLines(3, "x"), timedOut: false, durationMs: 1 }),
		)

		const out = await run(
			dream
				.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
				.pipe(Effect.provide(provide(fs, log))) as Effect.Effect<unknown, unknown, never>,
		)

		// No model turn fired at all.
		expect(runTurnMock).not.toHaveBeenCalled()
		// Files untouched.
		expect(fs.diaryWrites).toHaveLength(0)
		expect(fs.state.diary).toBe(smallDiary)
		expect((out as { diaryConsolidated: boolean }).diaryConsolidated).toBe(false)
		expect((out as { diaryCompressed: boolean }).diaryCompressed).toBe(false)
		// Skip markers fired for both diary steps.
		const consolidateSkipped = log.events.some(
			(e) =>
				e.kind === "text" &&
				/dream_diary_consolidate_skipped: below_threshold/.test(
					(e as { text?: string }).text ?? "",
				),
		)
		const cullSkipped = log.events.some(
			(e) =>
				e.kind === "text" &&
				/dream_diary_cull_skipped: below_threshold/.test((e as { text?: string }).text ?? ""),
		)
		expect(consolidateSkipped).toBe(true)
		expect(cullSkipped).toBe(true)
	})

	it("runs the diary steps as before when DIARY.md is above the threshold", async () => {
		// A wide diary clears the gate → consolidate + cull both run on the model.
		const fs = makeFs({ diary: lines(40, "orig"), secrets: lines(6, "sec") })
		const log = makeLog()
		let call = 0
		runTurnMock.mockImplementation(() => {
			call++
			if (call === 1)
				return Effect.succeed({ output: lines(35, "consol"), timedOut: false, durationMs: 1 })
			return Effect.succeed({ output: lines(5, "culled"), timedOut: false, durationMs: 1 })
		})

		const out = await run(
			dream
				.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
				.pipe(Effect.provide(provide(fs, log))) as Effect.Effect<unknown, unknown, never>,
		)

		// All three turns fired; the diary was consolidated and culled (not skipped).
		expect(call).toBe(3)
		expect((out as { diaryConsolidated: boolean }).diaryConsolidated).toBe(true)
		expect((out as { diaryCompressed: boolean }).diaryCompressed).toBe(true)
		const anySkip = log.events.some(
			(e) =>
				e.kind === "text" && /_skipped: below_threshold/.test((e as { text?: string }).text ?? ""),
		)
		expect(anySkip).toBe(false)
	})

	it("skips the secrets cull (no write) when SECRETS.md is below the threshold, while the diary still compresses", async () => {
		// Wide diary (runs) + tiny secrets (gated off).
		const smallSecrets = tinyLines(6, "sec")
		expect(smallSecrets.length).toBeLessThan(4000)
		const fs = makeFs({ diary: lines(40, "orig"), secrets: smallSecrets })
		const log = makeLog()
		let call = 0
		runTurnMock.mockImplementation(() => {
			call++
			if (call === 1)
				return Effect.succeed({ output: lines(35, "consol"), timedOut: false, durationMs: 1 })
			return Effect.succeed({ output: lines(5, "culled"), timedOut: false, durationMs: 1 })
		})

		const out = await run(
			dream
				.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
				.pipe(Effect.provide(provide(fs, log))) as Effect.Effect<unknown, unknown, never>,
		)

		// Only the two diary turns fired — the secrets cull was gated off (no 3rd turn).
		expect(call).toBe(2)
		// Secrets untouched.
		expect(fs.secretsWrites).toHaveLength(0)
		expect(fs.state.secrets).toBe(smallSecrets)
		expect((out as { secretsCompressed: boolean }).secretsCompressed).toBe(false)
		const secretsSkipped = log.events.some(
			(e) =>
				e.kind === "text" &&
				/dream_secrets_cull_skipped: below_threshold/.test((e as { text?: string }).text ?? ""),
		)
		expect(secretsSkipped).toBe(true)
	})
})
