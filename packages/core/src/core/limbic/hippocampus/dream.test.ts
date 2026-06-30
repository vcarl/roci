import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { CommandExecutor } from "@effect/platform"
import type { UnifiedEvent } from "../../../logging/events.js"

// Mock the model turn so we can script the compressed output a "model" returns.
const { runTurnMock } = vi.hoisted(() => ({ runTurnMock: vi.fn() }))
vi.mock("../hypothalamus/process-runner.js", () => ({
  runTurn: runTurnMock,
}))

import { dream, DIARY_TARGET_LINES } from "./dream.js"
import { CharacterFs } from "../../../services/CharacterFs.js"
import { CharacterLog } from "../../../logging/log-writer.js"
import { OAuthToken } from "../../../services/OAuthToken.js"
import { DEFAULT_MODEL_CONFIG } from "../../model-config.js"

const char = { name: "ada", dir: "/work/players/ada/me" }

const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}-${i}`).join("\n")

/** Stateful CharacterFs fake: reads reflect prior writes. */
function makeFs(initial: { diary: string; secrets: string }) {
  const state = { ...initial }
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
      readBackground: () => Effect.succeed("BACKGROUND"),
      readValues: () => Effect.succeed("VALUES"),
      readPalette: () => Effect.succeed(""),
      readDrives: () => Effect.succeed(""),
      characterExists: () => Effect.succeed(true),
    }),
  )
  return { layer, state, diaryWrites, secretsWrites }
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
  // Deterministic dream type = normal (roll 50; nightmare<~1, good>=94).
  vi.spyOn(Math, "random").mockReturnValue(0.5)
})
afterEach(() => {
  vi.restoreAllMocks()
})

const run = (eff: Effect.Effect<unknown, unknown, never>) => Effect.runPromise(eff)

describe("dream cull — never-grows invariant", () => {
  it("discards a compressed diary that is LONGER than the input and keeps the original, logging a warning", async () => {
    const fs = makeFs({ diary: lines(10, "orig"), secrets: lines(5, "sec") })
    const log = makeLog()
    const longer = lines(100, "bloat")

    let call = 0
    runTurnMock.mockImplementation(() => {
      call++
      // call 1 = diary cull (returns LONGER), call 2 = secrets cull (returns shorter)
      const output = call === 1 ? longer : lines(2, "sec")
      return Effect.succeed({ output, timedOut: false, durationMs: 1 })
    })

    const program = dream
      .execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
      .pipe(Effect.provide(Layer.mergeAll(fs.layer, log.layer, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)))

    const out = await run(program as Effect.Effect<unknown, unknown, never>)

    // The longer output must never have been written.
    expect(fs.diaryWrites).not.toContain(longer)
    // Original diary is preserved.
    expect(fs.state.diary).toBe(lines(10, "orig"))
    expect((out as { diaryCompressed: boolean }).diaryCompressed).toBe(false)
    // A warning was logged about the discard.
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
      // call 1 = diary cull (shorter, accepted), call 2 = secrets cull (LONGER, discarded)
      const output = call === 1 ? lines(5, "culled") : longerSecrets
      return Effect.succeed({ output, timedOut: false, durationMs: 1 })
    })

    const program = dream
      .execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
      .pipe(Effect.provide(Layer.mergeAll(fs.layer, log.layer, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)))

    const out = await run(program as Effect.Effect<unknown, unknown, never>)

    expect(fs.secretsWrites).not.toContain(longerSecrets)
    expect(fs.state.secrets).toBe(lines(4, "sec"))
    expect((out as { secretsCompressed: boolean }).secretsCompressed).toBe(false)
    // A warning was logged about the secrets discard (mirrors the diary test).
    const warned = log.events.some(
      (e) => e.level === "warn" && e.kind === "system" && /secret/i.test(e.message),
    )
    expect(warned).toBe(true)
  })
})

describe("dream cull — failed/timed-out turn preserves originals", () => {
  it("keeps the original diary EXACTLY when the diary cull turn times out (empty output)", async () => {
    const fs = makeFs({ diary: lines(98, "orig"), secrets: lines(5, "sec") })
    const log = makeLog()

    let call = 0
    runTurnMock.mockImplementation(() => {
      call++
      // call 1 = diary cull TIMES OUT (empty output, timedOut:true)
      // call 2 = secrets cull succeeds (shorter)
      if (call === 1) return Effect.succeed({ output: "", timedOut: true, durationMs: 1 })
      return Effect.succeed({ output: lines(2, "sec"), timedOut: false, durationMs: 1 })
    })

    const program = dream
      .execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
      .pipe(Effect.provide(Layer.mergeAll(fs.layer, log.layer, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)))

    const out = await run(program as Effect.Effect<unknown, unknown, never>)

    // The empty/timed-out output must NEVER have been written to the diary.
    expect(fs.diaryWrites).toHaveLength(0)
    expect(fs.state.diary).toBe(lines(98, "orig"))
    expect((out as { diaryCompressed: boolean }).diaryCompressed).toBe(false)
    // The failure is surfaced as a structured error (not a successful X -> 0 compression).
    const failed = log.events.some(
      (e) => e.kind === "error" && /diar/i.test((e as { message?: string }).message ?? ""),
    )
    expect(failed).toBe(true)
    // It was NOT reported as a successful diary compression.
    const falselyCompressed = log.events.some(
      (e) => e.kind === "text" && /dream_diary_compressed/.test((e as { text?: string }).text ?? ""),
    )
    expect(falselyCompressed).toBe(false)
  })

  it("keeps the original secrets EXACTLY when the secrets cull turn times out (empty output)", async () => {
    const fs = makeFs({ diary: lines(30, "orig"), secrets: lines(40, "sec") })
    const log = makeLog()

    let call = 0
    runTurnMock.mockImplementation(() => {
      call++
      // call 1 = diary cull succeeds (shorter), call 2 = secrets cull TIMES OUT (empty)
      if (call === 1) return Effect.succeed({ output: lines(8, "culled"), timedOut: false, durationMs: 1 })
      return Effect.succeed({ output: "", timedOut: true, durationMs: 1 })
    })

    const program = dream
      .execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
      .pipe(Effect.provide(Layer.mergeAll(fs.layer, log.layer, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)))

    const out = await run(program as Effect.Effect<unknown, unknown, never>)

    expect(fs.secretsWrites).toHaveLength(0)
    expect(fs.state.secrets).toBe(lines(40, "sec"))
    expect((out as { secretsCompressed: boolean }).secretsCompressed).toBe(false)
    const failed = log.events.some(
      (e) => e.kind === "error" && /secret/i.test((e as { message?: string }).message ?? ""),
    )
    expect(failed).toBe(true)
  })

  it("treats a whitespace-only diary turn output as a failure and keeps the original", async () => {
    const fs = makeFs({ diary: lines(50, "orig"), secrets: lines(5, "sec") })
    const log = makeLog()

    let call = 0
    runTurnMock.mockImplementation(() => {
      call++
      // call 1 = diary cull returns whitespace-only (process exited 0 but no real text)
      if (call === 1) return Effect.succeed({ output: "   \n  \n\t", timedOut: false, durationMs: 1 })
      return Effect.succeed({ output: lines(2, "sec"), timedOut: false, durationMs: 1 })
    })

    const program = dream
      .execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
      .pipe(Effect.provide(Layer.mergeAll(fs.layer, log.layer, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)))

    const out = await run(program as Effect.Effect<unknown, unknown, never>)

    expect(fs.diaryWrites).toHaveLength(0)
    expect(fs.state.diary).toBe(lines(50, "orig"))
    expect((out as { diaryCompressed: boolean }).diaryCompressed).toBe(false)
  })
})

describe("dream cull — target compression", () => {
  it("writes the compressed diary when it is shorter than the input", async () => {
    const fs = makeFs({ diary: lines(40, "orig"), secrets: lines(6, "sec") })
    const log = makeLog()
    const culled = lines(8, "culled")

    let call = 0
    runTurnMock.mockImplementation(() => {
      call++
      const output = call === 1 ? culled : lines(3, "sec")
      return Effect.succeed({ output, timedOut: false, durationMs: 1 })
    })

    const program = dream
      .execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
      .pipe(Effect.provide(Layer.mergeAll(fs.layer, log.layer, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)))

    const out = await run(program as Effect.Effect<unknown, unknown, never>)

    expect(fs.diaryWrites).toContain(culled)
    expect(fs.state.diary).toBe(culled)
    expect((out as { diaryCompressed: boolean }).diaryCompressed).toBe(true)
  })

  it("exposes a DIARY_TARGET_LINES constant of 150 and renders it into the cull prompt", async () => {
    expect(DIARY_TARGET_LINES).toBe(150)

    const fs = makeFs({ diary: lines(40, "orig"), secrets: lines(6, "sec") })
    const log = makeLog()
    const prompts: string[] = []
    runTurnMock.mockImplementation((config: { prompt: string }) => {
      prompts.push(config.prompt)
      return Effect.succeed({ output: lines(5, "culled"), timedOut: false, durationMs: 1 })
    })

    const program = dream
      .execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
      .pipe(Effect.provide(Layer.mergeAll(fs.layer, log.layer, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)))

    await run(program as Effect.Effect<unknown, unknown, never>)

    // The diary cull prompt (first turn) mentions the target line count.
    expect(prompts[0]).toContain(String(DIARY_TARGET_LINES))
  })
})
