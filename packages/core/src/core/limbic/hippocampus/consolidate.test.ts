import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { CommandExecutor } from "@effect/platform"
import type { UnifiedEvent } from "../../../logging/events.js"

// Mock the model turn so we can script what the "model" returns (or how it fails).
const { runTurnMock } = vi.hoisted(() => ({ runTurnMock: vi.fn() }))
vi.mock("../hypothalamus/process-runner.js", () => ({
  runTurn: runTurnMock,
}))

import { consolidate } from "./consolidate.js"
import { CharacterFs } from "../../../services/CharacterFs.js"
import { CharacterLog } from "../../../logging/log-writer.js"
import { OAuthToken } from "../../../services/OAuthToken.js"
import { DEFAULT_MODEL_CONFIG } from "../../model-config.js"

const char = { name: "ada", dir: "/work/players/ada/me" }

const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}-${i}`).join("\n")

/** Stateful CharacterFs fake: reads reflect prior writes. */
function makeFs(initial: { diary: string }) {
  const state = { diary: initial.diary }
  const diaryWrites: string[] = []
  const layer = Layer.succeed(
    CharacterFs,
    CharacterFs.of({
      readDiary: () => Effect.succeed(state.diary),
      writeDiary: (_c, content) =>
        Effect.sync(() => {
          state.diary = content
          diaryWrites.push(content)
        }),
      readSecrets: () => Effect.succeed(""),
      writeSecrets: () => Effect.void,
      readCredentials: () => Effect.succeed({ username: "", password: "" }),
      readBackground: () => Effect.succeed("BACKGROUND"),
      readValues: () => Effect.succeed("VALUES"),
      readPalette: () => Effect.succeed(""),
      readDrives: () => Effect.succeed(""),
      characterExists: () => Effect.succeed(true),
    }),
  )
  return { layer, state, diaryWrites }
}

function makeLog() {
  const events: UnifiedEvent[] = []
  const layer = Layer.succeed(
    CharacterLog,
    CharacterLog.of({ emit: (_c, e) => Effect.sync(() => { events.push(e) }) }),
  )
  return { layer, events }
}

const StubCommandExecutor = Layer.succeed(
  CommandExecutor.CommandExecutor,
  { start: () => { throw new Error("stub") } } as unknown as CommandExecutor.CommandExecutor,
)
const StubOAuthToken = Layer.succeed(
  OAuthToken,
  OAuthToken.of({
    getToken: Effect.succeed({ token: "stub", version: 0 }),
    validateInContainer: () => Effect.succeed(true),
  }),
)

beforeEach(() => {
  runTurnMock.mockReset()
})
afterEach(() => {
  vi.restoreAllMocks()
})

const run = (eff: Effect.Effect<unknown, unknown, never>) => Effect.runPromise(eff)

const provide = (fs: ReturnType<typeof makeFs>, log: ReturnType<typeof makeLog>) =>
  Layer.mergeAll(fs.layer, log.layer, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)

describe("consolidate — failed/timed-out turn preserves the diary", () => {
  it("keeps the original diary EXACTLY when the turn times out (empty output)", async () => {
    const fs = makeFs({ diary: lines(76, "orig") })
    const log = makeLog()
    runTurnMock.mockImplementation(() =>
      Effect.succeed({ output: "", timedOut: true, durationMs: 1 }),
    )

    const program = consolidate
      .execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
      .pipe(Effect.provide(provide(fs, log)))

    const out = await run(program as Effect.Effect<unknown, unknown, never>)

    // The empty/timed-out output must NEVER overwrite the diary.
    expect(fs.diaryWrites).toHaveLength(0)
    expect(fs.state.diary).toBe(lines(76, "orig"))
    expect((out as { diaryConsolidated: boolean }).diaryConsolidated).toBe(false)
    // No false "consolidate_complete (76 -> 1 lines)" success line.
    const falselyComplete = log.events.some(
      (e) => e.kind === "text" && /consolidate_complete/.test((e as { text?: string }).text ?? ""),
    )
    expect(falselyComplete).toBe(false)
    // The failure is surfaced as a structured error.
    const failed = log.events.some(
      (e) => e.kind === "error" && /consolidat/i.test((e as { message?: string }).message ?? ""),
    )
    expect(failed).toBe(true)
  })

  it("keeps the original diary when the turn returns whitespace-only output", async () => {
    const fs = makeFs({ diary: lines(60, "orig") })
    const log = makeLog()
    runTurnMock.mockImplementation(() =>
      Effect.succeed({ output: "  \n\t\n ", timedOut: false, durationMs: 1 }),
    )

    const program = consolidate
      .execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
      .pipe(Effect.provide(provide(fs, log)))

    const out = await run(program as Effect.Effect<unknown, unknown, never>)

    expect(fs.diaryWrites).toHaveLength(0)
    expect(fs.state.diary).toBe(lines(60, "orig"))
    expect((out as { diaryConsolidated: boolean }).diaryConsolidated).toBe(false)
  })

  it("writes the consolidated diary on a successful turn", async () => {
    const fs = makeFs({ diary: lines(20, "orig") })
    const log = makeLog()
    const rewritten = lines(25, "narrative")
    runTurnMock.mockImplementation(() =>
      Effect.succeed({ output: rewritten, timedOut: false, durationMs: 1 }),
    )

    const program = consolidate
      .execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
      .pipe(Effect.provide(provide(fs, log)))

    const out = await run(program as Effect.Effect<unknown, unknown, never>)

    expect(fs.diaryWrites).toContain(rewritten)
    expect(fs.state.diary).toBe(rewritten)
    expect((out as { diaryConsolidated: boolean }).diaryConsolidated).toBe(true)
    const completed = log.events.some(
      (e) => e.kind === "text" && /consolidate_complete/.test((e as { text?: string }).text ?? ""),
    )
    expect(completed).toBe(true)
  })
})
