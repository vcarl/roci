import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Effect, Layer, Queue } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { CommandExecutor } from "@effect/platform"

// Mock the model turn used by both consolidate and dream (cull).
const { runTurnMock } = vi.hoisted(() => ({ runTurnMock: vi.fn() }))
vi.mock("../limbic/hypothalamus/process-runner.js", () => ({
  runTurn: runTurnMock,
}))

import { runReflection, runBreak } from "./planned-action.js"
import { CharacterFs } from "../../services/CharacterFs.js"
import { CharacterLog } from "../../logging/log-writer.js"
import { OAuthToken } from "../../services/OAuthToken.js"
import { DEFAULT_MODEL_CONFIG } from "../model-config.js"
import { EventProcessorTag } from "../limbic/thalamus/event-processor.js"
import { SituationClassifierTag } from "../limbic/thalamus/situation-classifier.js"
import { InterruptRegistryTag } from "../limbic/amygdala/interrupt.js"
import type { PlannedActionTempo } from "../limbic/hypothalamus/tempo.js"

const char = { name: "ada", dir: "/work/players/ada/me" }

const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}-${i}`).join("\n")

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

const fakeLog = Layer.succeed(CharacterLog, CharacterLog.of({ emit: () => Effect.void }))
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
  vi.spyOn(Math, "random").mockReturnValue(0.5)
})
afterEach(() => {
  vi.restoreAllMocks()
})

const run = (eff: Effect.Effect<unknown, unknown, never>) => Effect.runPromise(eff)

describe("runReflection — per-cycle consolidate then cull", () => {
  it("runs the cull (dream) even when the diary is small (gate removed)", async () => {
    const fs = makeFs({ diary: lines(3, "tiny"), secrets: lines(4, "sec") })

    let call = 0
    runTurnMock.mockImplementation(() => {
      call++
      // 1 = consolidate, 2 = dream diary cull, 3 = dream secrets cull
      return Effect.succeed({ output: lines(2, `t${call}`), timedOut: false, durationMs: 1 })
    })

    const program = runReflection(char, "c1", DEFAULT_MODEL_CONFIG).pipe(
      Effect.provide(Layer.mergeAll(fs.layer, fakeLog, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)),
    )
    await run(program as Effect.Effect<unknown, unknown, never>)

    // Dream is the only step that touches SECRETS.md — proves the cull ran on a tiny diary.
    expect(fs.secretsWrites.length).toBeGreaterThanOrEqual(1)
    // consolidate + dream(diary) + dream(secrets) = 3 model turns.
    expect(call).toBe(3)
  })

  it("logs a STRUCTURED error (kind:error) and continues when consolidate fails", async () => {
    const fs = makeFs({ diary: lines(3, "d"), secrets: lines(4, "s") })
    const errorMessages: string[] = []
    const recordingLog = Layer.succeed(
      CharacterLog,
      CharacterLog.of({
        emit: (_c, e) => Effect.sync(() => { if (e.kind === "error") errorMessages.push(e.message) }),
      }),
    )
    // Call 1 = consolidate (fails); calls 2,3 = dream culls (succeed).
    let call = 0
    runTurnMock.mockImplementation(() => {
      call++
      if (call === 1) return Effect.fail(new Error("consolidate boom"))
      return Effect.succeed({ output: lines(2, `t${call}`), timedOut: false, durationMs: 1 })
    })

    const program = runReflection(char, "c1", DEFAULT_MODEL_CONFIG).pipe(
      Effect.provide(Layer.mergeAll(fs.layer, recordingLog, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)),
    )
    // Must NOT throw — reflection is best-effort; the agent keeps running.
    await run(program as Effect.Effect<unknown, unknown, never>)

    expect(errorMessages.some((m) => m.toLowerCase().includes("consolidate"))).toBe(true)
    // The dream cull still ran after the consolidate failure (best-effort continuation).
    expect(call).toBe(3)
  })

  it("logs a STRUCTURED error (kind:error) and continues when dream (cull) fails", async () => {
    const fs = makeFs({ diary: lines(3, "d"), secrets: lines(4, "s") })
    const errorMessages: string[] = []
    const recordingLog = Layer.succeed(
      CharacterLog,
      CharacterLog.of({
        emit: (_c, e) => Effect.sync(() => { if (e.kind === "error") errorMessages.push(e.message) }),
      }),
    )
    // Call 1 = consolidate (succeeds); call 2 = dream diary cull (fails).
    let call = 0
    runTurnMock.mockImplementation(() => {
      call++
      if (call === 1) return Effect.succeed({ output: "CONSOLIDATED", timedOut: false, durationMs: 1 })
      return Effect.fail(new Error("dream boom"))
    })

    const program = runReflection(char, "c1", DEFAULT_MODEL_CONFIG).pipe(
      Effect.provide(Layer.mergeAll(fs.layer, recordingLog, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)),
    )
    await run(program as Effect.Effect<unknown, unknown, never>)

    expect(errorMessages.some((m) => m.toLowerCase().includes("dream"))).toBe(true)
  })

  it("consolidates the diary BEFORE the cull and writes the consolidate output", async () => {
    const fs = makeFs({ diary: lines(3, "raw"), secrets: lines(4, "sec") })

    let call = 0
    runTurnMock.mockImplementation(() => {
      call++
      if (call === 1) return Effect.succeed({ output: "CONSOLIDATED_OUTPUT", timedOut: false, durationMs: 1 })
      if (call === 2) return Effect.succeed({ output: "culled_diary", timedOut: false, durationMs: 1 })
      return Effect.succeed({ output: "culled_secrets", timedOut: false, durationMs: 1 })
    })

    const program = runReflection(char, "c1", DEFAULT_MODEL_CONFIG).pipe(
      Effect.provide(Layer.mergeAll(fs.layer, fakeLog, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)),
    )
    await run(program as Effect.Effect<unknown, unknown, never>)

    // The first diary write came from consolidate, before the cull's write.
    expect(fs.diaryWrites[0]).toBe("CONSOLIDATED_OUTPUT")
    expect(fs.diaryWrites).toContain("CONSOLIDATED_OUTPUT")
  })
})

describe("runBreak — event-processing error path", () => {
  it("logs a STRUCTURED error (kind:error) on a throwing processEvent and keeps draining", async () => {
    const errorMessages: string[] = []
    const recordingLog = Layer.succeed(
      CharacterLog,
      CharacterLog.of({
        emit: (_c, e) => Effect.sync(() => { if (e.kind === "error") errorMessages.push(e.message) }),
      }),
    )
    const throwingProcessor = Layer.succeed(
      EventProcessorTag,
      EventProcessorTag.of({ processEvent: () => { throw new Error("boom") } }),
    )
    const classifier = Layer.succeed(
      SituationClassifierTag,
      SituationClassifierTag.of({
        summarize: () => ({ situation: {} as never, headline: "h", sections: [], metrics: {} }),
      }),
    )
    const interrupts = Layer.succeed(
      InterruptRegistryTag,
      InterruptRegistryTag.of({ rules: [], evaluate: () => [], softAlerts: () => [], criticals: () => [] }),
    )
    // A tiny break window so the loop drains the bad event then exits promptly.
    const tempo = { breakDurationMs: 1, breakPollIntervalSec: 0 } as unknown as PlannedActionTempo

    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "x" })
      return yield* runBreak({ char, events, initialState: {}, tempo })
    }).pipe(Effect.provide(Layer.mergeAll(throwingProcessor, classifier, interrupts, recordingLog)))

    const result = await Effect.runPromise(program as Effect.Effect<{ _tag: string }, unknown, never>)
    // Control flow unchanged: best-effort, the break still completes.
    expect(result._tag).toBe("Completed")
    expect(errorMessages.some((m) => m.toLowerCase().includes("event processing error during break"))).toBe(true)
  })
})
