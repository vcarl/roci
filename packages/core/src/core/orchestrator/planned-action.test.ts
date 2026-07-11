import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Effect, Layer, Queue } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { CommandExecutor } from "@effect/platform"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// Mock the model turn used by both consolidate and dream (cull).
const { runTurnMock } = vi.hoisted(() => ({ runTurnMock: vi.fn() }))
vi.mock("../../brain/transport/process-runner.js", () => ({
  runTurn: runTurnMock,
}))

import { runReflection, runBreak } from "./planned-action.js"
import { LongtermStore, diaryMark, type DiaryMark } from "#brain/limbic/hippocampus/memory/longterm-store.js"
import { CharacterFs } from "../../services/CharacterFs.js"
import { CharacterLog } from "../../logging/log-writer.js"
import { OAuthToken } from "../../services/OAuthToken.js"
import { DEFAULT_MODEL_CONFIG } from "../model-config.js"
import { DEFAULT_CORTEX_MODELS } from "../../model/handles.js"
import { consciousModelLabel } from "../../model/conscious-label.js"
import { EventProcessorTag } from "#brain/limbic/thalamus/event-processor.js"
import { SituationClassifierTag } from "#brain/limbic/thalamus/situation-classifier.js"
import { InterruptRegistryTag } from "#brain/limbic/amygdala/interrupt.js"
import type { PlannedActionTempo } from "#brain/limbic/hypothalamus/tempo.js"
import { setEpisodeLogRoot, appendToolEpisode, appendTransitionEpisode } from "../../logging/episodes.js"
import { readProposals, appendProposals, bumpMacroCount, adjudicationsJsonlPath } from "#brain/limbic/hippocampus/growth-store.js"

// `char.dir` mirrors the (host-side) character directory growth-store.ts reads
// and writes real files under — now that runReflection wires in the macro
// stage, every runReflection(char, ...) call performs a real (never-fail)
// filesystem bump of the macro-cycle counter here. A fixed, non-existent path
// (the old placeholder was the in-container "/work/..." convention, not a real
// host dir) would make every bump fail-and-fall-back-to-0, which — because the
// gate is `count % macroEveryN() === 0` — spuriously matches on 0 and runs the
// macro turn on EVERY reflection, breaking the call-count assertions below. A
// fresh, writable temp dir per test keeps every pre-existing test's counter at
// a genuinely low, non-multiple-of-N value, so macro's internal gate skips the
// turn exactly as it did before this stage existed.
let char: { name: string; dir: string }
let charRoot: string

const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}-${i}`).join("\n")

// `synthesis` defaults NON-EMPTY so the memory-index bootstrap stage (which fires
// only when SYNTHESIS.md is absent/blank) SKIPS its turn in the pre-existing
// reflection tests — keeping their model-turn call counts intact. Tests that
// exercise the bootstrap pass `synthesis: ""` explicitly.
function makeFs(initial: { diary: string; secrets: string; synthesis?: string }) {
  const state = { synthesis: "SEEDED-SELF-MODEL", ...initial }
  const diaryWrites: string[] = []
  const secretsWrites: string[] = []
  const synthesisWrites: string[] = []
  // Tracks every readDiary call — both the pre-consolidate promotion read and
  // the post-cull re-baseline-mark read hit this, so a non-empty log after a
  // run is a cheap proxy for "the re-baseline mark step still executed".
  const markWrites: string[] = []
  const layer = Layer.succeed(
    CharacterFs,
    CharacterFs.of({
      readDiary: () =>
        Effect.sync(() => {
          markWrites.push(state.diary)
          return state.diary
        }),
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
      listSkills: () => Effect.succeed([]),
      readSkill: () => Effect.succeed(null),
      writeSkill: () => Effect.void,
      readSynthesis: () => Effect.succeed(state.synthesis),
      writeSynthesis: (_c, content) =>
        Effect.sync(() => {
          state.synthesis = content
          synthesisWrites.push(content)
        }),
      deleteSkill: () => Effect.void,
    }),
  )
  return { layer, state, diaryWrites, secretsWrites, synthesisWrites, markWrites }
}

/**
 * Fake LongtermStore: records every promote() call and holds the bounded
 * high-water mark in memory (readMark/writeMark), so a real two-cycle churn test
 * exercises the actual dedup. Can be made to fail on promote.
 */
function makeStore(opts: { failPromote?: boolean } = {}) {
  const promotedCalls: string[][] = []
  let mark: DiaryMark | null = null
  const layer = Layer.succeed(
    LongtermStore,
    LongtermStore.of({
      readMark: () => Effect.succeed(mark),
      writeMark: (_id, _char, m) => Effect.sync(() => { mark = m }),
      promote: (_id, _char, entries) =>
        opts.failPromote
          ? Effect.fail(new Error("promote boom"))
          : Effect.sync(() => {
              promotedCalls.push([...entries])
              return entries.length
            }),
      remember: () => Effect.void,
      recall: () => Effect.succeed([]),
    }),
  )
  return { layer, promotedCalls, getMark: () => mark }
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
  charRoot = fs.mkdtempSync(path.join(os.tmpdir(), "planned-action-char-"))
  char = { name: "ada", dir: path.join(charRoot, "players", "ada", "me") }
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(charRoot, { recursive: true, force: true })
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
      Effect.provide(Layer.mergeAll(fs.layer, makeStore().layer, fakeLog, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)),
    )
    await run(program as Effect.Effect<unknown, unknown, never>)

    // Dream is the only step that touches SECRETS.md — proves the cull ran on a tiny diary.
    expect(fs.secretsWrites.length).toBeGreaterThanOrEqual(1)
    // consolidate + dream(diary) + dream(secrets) = 3 model turns.
    expect(call).toBe(3)
  })

  it("runs the ENTIRE reflection dream on the local model — one unified step, zero claude passes", async () => {
    const fs = makeFs({ diary: lines(3, "tiny"), secrets: lines(4, "sec") })
    const modelsUsed: string[] = []
    let call = 0
    runTurnMock.mockImplementation((config: { model: string }) => {
      modelsUsed.push(config.model)
      call++
      return Effect.succeed({ output: lines(2, `t${call}`), timedOut: false, durationMs: 1 })
    })

    const program = runReflection(char, "c1", DEFAULT_MODEL_CONFIG).pipe(
      Effect.provide(Layer.mergeAll(fs.layer, makeStore().layer, fakeLog, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)),
    )
    await run(program as Effect.Effect<unknown, unknown, never>)

    const local = consciousModelLabel(DEFAULT_CORTEX_MODELS.conscious)
    // Exactly one unified dream step = 3 local turns (consolidate + 2 culls); no extra pass.
    expect(call).toBe(3)
    expect(modelsUsed).toEqual([local, local, local])
    // No turn resolved to a claude tier — Claude is never invoked in the reflection path.
    for (const m of modelsUsed) expect(["haiku", "sonnet", "opus"]).not.toContain(m)
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
      Effect.provide(Layer.mergeAll(fs.layer, makeStore().layer, recordingLog, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)),
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
      Effect.provide(Layer.mergeAll(fs.layer, makeStore().layer, recordingLog, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)),
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
      Effect.provide(Layer.mergeAll(fs.layer, makeStore().layer, fakeLog, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)),
    )
    await run(program as Effect.Effect<unknown, unknown, never>)

    // The first diary write came from consolidate, before the cull's write.
    expect(fs.diaryWrites[0]).toBe("CONSOLIDATED_OUTPUT")
    expect(fs.diaryWrites).toContain("CONSOLIDATED_OUTPUT")
  })
})

describe("runReflection — pre-consolidate raw promotion (Unit 7)", () => {
  // Promotion runs BEFORE consolidate (capturing RAW episodic appends) and the
  // mark is re-baselined to the post-cull diary. consolidate/dream outputs are
  // single-line so the dream never-grows invariant writes them.
  const deps = (fs: ReturnType<typeof makeFs>, store: ReturnType<typeof makeStore>, log = fakeLog) =>
    Layer.mergeAll(fs.layer, store.layer, log, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)

  it("promotes RAW pre-consolidate entries and re-baselines a bounded mark to the post-cull diary", async () => {
    const fs = makeFs({ diary: "Raw A.\n\nRaw B.", secrets: lines(4, "sec") })
    const store = makeStore()
    let call = 0
    runTurnMock.mockImplementation(() => {
      call++
      if (call === 1) return Effect.succeed({ output: "NARRATIVE-1", timedOut: false, durationMs: 1 })
      if (call === 2) return Effect.succeed({ output: "CULLED-1", timedOut: false, durationMs: 1 })
      return Effect.succeed({ output: "sec-1", timedOut: false, durationMs: 1 })
    })
    await run(
      runReflection(char, "c1", DEFAULT_MODEL_CONFIG).pipe(Effect.provide(deps(fs, store))) as Effect.Effect<unknown, unknown, never>,
    )

    // Promoted the RAW pre-consolidate entries — NOT the consolidated narrative
    // (proves the read happened before consolidate overwrote the diary).
    expect(store.promotedCalls).toEqual([["Raw A.", "Raw B."]])
    // Mark re-baselined to the post-cull diary (bounded single object).
    expect(store.getMark()).toEqual(diaryMark("CULLED-1"))
    // Consolidate + cull still ran.
    expect(fs.diaryWrites).toContain("NARRATIVE-1")
    expect(fs.secretsWrites.length).toBeGreaterThanOrEqual(1)
  })

  it("across two cycles with DIFFERENT consolidate text, promotes ONLY genuinely-new raw entries (no churn re-promotion)", async () => {
    const store = makeStore()
    // Distinct consolidate/cull text per cycle — a byte-identical fake would mask
    // the churn bug; here the narrative genuinely changes between cycles.
    const outputs = ["NARRATIVE-1", "CULLED-1", "sec-1", "NARRATIVE-2", "CULLED-2", "sec-2"]
    let call = 0
    runTurnMock.mockImplementation(() =>
      Effect.succeed({ output: outputs[call++] ?? "x", timedOut: false, durationMs: 1 }),
    )

    // Cycle 1: session's raw appends, no prior mark.
    const fs1 = makeFs({ diary: "Raw A.\n\nRaw B.", secrets: lines(4, "sec") })
    await run(runReflection(char, "c1", DEFAULT_MODEL_CONFIG).pipe(Effect.provide(deps(fs1, store))) as Effect.Effect<unknown, unknown, never>)

    // Cycle 2: a NEW session appended one raw entry onto the culled diary cycle 1
    // left ("CULLED-1"), exactly as the live loop appends.
    const fs2 = makeFs({ diary: "CULLED-1\n\nRaw C.", secrets: lines(4, "sec") })
    await run(runReflection(char, "c1", DEFAULT_MODEL_CONFIG).pipe(Effect.provide(deps(fs2, store))) as Effect.Effect<unknown, unknown, never>)

    // Only the genuinely-new raw entries each cycle — the prior content and the
    // (changed) consolidated narratives are NOT re-promoted.
    expect(store.promotedCalls).toEqual([["Raw A.", "Raw B."], ["Raw C."]])
    expect(store.getMark()).toEqual(diaryMark("CULLED-2"))
  })

  it("a failing promotion logs a STRUCTURED error and does NOT block consolidate/cull", async () => {
    const fs = makeFs({ diary: "Raw A.", secrets: lines(4, "sec") })
    const store = makeStore({ failPromote: true })
    const errorMessages: string[] = []
    const recordingLog = Layer.succeed(
      CharacterLog,
      CharacterLog.of({
        emit: (_c, e) => Effect.sync(() => { if (e.kind === "error") errorMessages.push(e.message) }),
      }),
    )
    let call = 0
    runTurnMock.mockImplementation(() => {
      call++
      if (call === 1) return Effect.succeed({ output: "NARRATIVE-1", timedOut: false, durationMs: 1 })
      return Effect.succeed({ output: "x", timedOut: false, durationMs: 1 })
    })
    await run(
      runReflection(char, "c1", DEFAULT_MODEL_CONFIG).pipe(Effect.provide(deps(fs, store, recordingLog))) as Effect.Effect<unknown, unknown, never>,
    )

    expect(errorMessages.some((m) => m.toLowerCase().includes("promotion"))).toBe(true)
    // consolidate + cull still ran after the promotion failure (best-effort).
    expect(fs.diaryWrites).toContain("NARRATIVE-1")
    expect(fs.secretsWrites.length).toBeGreaterThanOrEqual(1)
  })
})

describe("runReflection — reflection behaviors", () => {
  it("emits reflection promote with promoted:0 even when nothing is fresh, plus consolidate + dream start", async () => {
    const fs = makeFs({ diary: "", secrets: lines(4, "sec") })
    const store = makeStore()
    const behaviors: Array<{ type: string; [k: string]: unknown }> = []
    const recordingLog = Layer.succeed(
      CharacterLog,
      CharacterLog.of({
        emit: (_c, e) => Effect.sync(() => { if (e.kind === "behavior") behaviors.push(e.behavior as never) }),
      }),
    )
    let call = 0
    runTurnMock.mockImplementation(() => {
      call++
      return Effect.succeed({ output: `out-${call}`, timedOut: false, durationMs: 1 })
    })

    const program = runReflection(char, "c1", DEFAULT_MODEL_CONFIG).pipe(
      Effect.provide(Layer.mergeAll(fs.layer, store.layer, recordingLog, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)),
    )
    await run(program as Effect.Effect<unknown, unknown, never>)

    const reflections = behaviors.filter((b) => b.type === "reflection")
    const promote = reflections.find((b) => b.stage === "promote")
    expect(promote).toBeDefined()
    expect(promote!.status).toBe("done")
    expect((promote!.counts as Record<string, number>).promoted).toBe(0)
    expect(reflections.some((b) => b.stage === "dream" && b.status === "start")).toBe(true)
    // Empty diary → no fresh entries → store.promote is never called (n is forced to 0).
    expect(store.promotedCalls).toEqual([])
  })
})

describe("runReflection — memory-index bootstrap (wiring)", () => {
  it("with an empty SYNTHESIS.md, runs the bootstrap turn AFTER dream and writes the memory index", async () => {
    const fsx = makeFs({ diary: lines(3, "d"), secrets: lines(4, "s"), synthesis: "" })
    const modelsUsed: string[] = []
    let call = 0
    runTurnMock.mockImplementation((config: { model: string }) => {
      modelsUsed.push(config.model)
      call++
      // No episode root here → retrospect skips (no turn). macro skips (fresh
      // counter). So: 1=consolidate, 2=dream diary, 3=dream secrets, 4=bootstrap.
      if (call === 4) return Effect.succeed({ output: "I am Ada, only just beginning.", timedOut: false, durationMs: 1 })
      return Effect.succeed({ output: lines(2, `t${call}`), timedOut: false, durationMs: 1 })
    })

    await run(
      runReflection(char, "c1", DEFAULT_MODEL_CONFIG).pipe(
        Effect.provide(Layer.mergeAll(fsx.layer, makeStore().layer, fakeLog, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)),
      ) as Effect.Effect<unknown, unknown, never>,
    )

    expect(call).toBe(4) // the extra bootstrap turn ran
    // Bootstrap ran on the smart tier; the three dream turns ran on the local model.
    const local = consciousModelLabel(DEFAULT_CORTEX_MODELS.conscious)
    expect(modelsUsed).toEqual([local, local, local, "sonnet"])
    // The memory index was written (bounded), trailing newline from the shared clamp.
    expect(fsx.synthesisWrites.at(-1)).toContain("I am Ada, only just beginning.")
  })

  it("with a non-empty SYNTHESIS.md, the bootstrap SKIPS its turn and writes nothing", async () => {
    const fsx = makeFs({ diary: lines(3, "d"), secrets: lines(4, "s") }) // default synthesis is non-empty
    let call = 0
    runTurnMock.mockImplementation(() => {
      call++
      return Effect.succeed({ output: lines(2, `t${call}`), timedOut: false, durationMs: 1 })
    })

    await run(
      runReflection(char, "c1", DEFAULT_MODEL_CONFIG).pipe(
        Effect.provide(Layer.mergeAll(fsx.layer, makeStore().layer, fakeLog, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)),
      ) as Effect.Effect<unknown, unknown, never>,
    )

    expect(call).toBe(3) // consolidate + 2 dream culls only — no bootstrap turn
    expect(fsx.synthesisWrites).toEqual([]) // existing memory index never overwritten
  })

  it("empty synthesis AND an Nth macro cycle in ONE reflection: bootstrap writes first, macro's synthesize reads the FRESH bootstrap as its base, final file is macro's rewrite", async () => {
    const fsx = makeFs({ diary: lines(3, "d"), secrets: lines(4, "s"), synthesis: "" })
    // Advance the persisted counter so THIS reflection's macro bump lands on N.
    const N = 4
    for (let i = 0; i < N - 1; i++) await Effect.runPromise(bumpMacroCount(char))

    // No episode root → retrospect skips (no turn). Turn order:
    // 1=consolidate, 2=dream diary, 3=dream secrets, 4=BOOTSTRAP, 5=MACRO.
    const prompts: string[] = []
    let call = 0
    runTurnMock.mockImplementation((config: { prompt: string }) => {
      prompts.push(config.prompt)
      call++
      if (call === 4) return Effect.succeed({ output: "I am Ada, only just beginning.", timedOut: false, durationMs: 1 })
      if (call === 5) {
        return Effect.succeed({
          output: JSON.stringify({ adjudications: [], synthesis: "I have grown past my first draft.", diaryNote: "note" }),
          timedOut: false, durationMs: 1,
        })
      }
      return Effect.succeed({ output: lines(2, `t${call}`), timedOut: false, durationMs: 1 })
    })

    await run(
      runReflection(char, "c1", DEFAULT_MODEL_CONFIG).pipe(
        Effect.provide(Layer.mergeAll(fsx.layer, makeStore().layer, fakeLog, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)),
      ) as Effect.Effect<unknown, unknown, never>,
    )

    expect(call).toBe(5) // bootstrap AND macro both ran this cycle
    // Macro's prompt embedded the FRESH bootstrap memory index as its current
    // synthesis — not the pre-bootstrap empty placeholder. This pins the
    // bootstrap-before-macro ordering the wiring guarantees.
    expect(prompts[4]).toContain("I am Ada, only just beginning.")
    expect(prompts[4]).not.toContain("(no memory index yet)")
    // Two writes, in order: the bootstrap seed, then macro's rewrite — and the
    // file ends up as macro's rewrite.
    expect(fsx.synthesisWrites).toHaveLength(2)
    expect(fsx.synthesisWrites[0]).toContain("I am Ada, only just beginning.")
    expect(fsx.synthesisWrites[1]).toContain("I have grown past my first draft.")
    expect(fsx.state.synthesis).toBe("I have grown past my first draft.\n")
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

describe("runReflection — episode cycle rotation", () => {
  it("closes the episode cycle: cycle-boundary appended to both streams, best-effort", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "episodes-reflect-"))
    setEpisodeLogRoot(root)
    try {
      await Effect.runPromise(
        appendToolEpisode("ada", {
          ts: "t", tick: 1, stepId: "s1-0", tool: "bash", argsSummary: "{}", status: "completed", durationMs: 1,
        }),
      )
      const fsx = makeFs({ diary: lines(3, "d"), secrets: lines(4, "s") })
      runTurnMock.mockImplementation(() => Effect.succeed({ output: "x", timedOut: false, durationMs: 1 }))
      await run(
        runReflection(char, "c1", DEFAULT_MODEL_CONFIG).pipe(
          Effect.provide(Layer.mergeAll(fsx.layer, makeStore().layer, fakeLog, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)),
        ) as Effect.Effect<unknown, unknown, never>,
      )
      for (const file of ["episodes-tool.jsonl", "episodes-transition.jsonl"]) {
        const text = fs.readFileSync(path.join(root, "players", "ada", "logs", file), "utf8")
        const recs = text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
        expect(recs.some((r) => r.type === "cycle-boundary")).toBe(true)
      }
    } finally {
      setEpisodeLogRoot(null)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("runReflection — meso retrospect (Stage 4)", () => {
  it("runs the retrospect AFTER promote and appends evidence-bearing proposals", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "reflect-retro-"))
    setEpisodeLogRoot(root)
    const charT = { name: "ada", dir: path.join(root, "players", "ada", "me") }
    try {
      // Current cycle: one failed step worn with a skill, one tool error.
      await Effect.runPromise(appendTransitionEpisode("ada", {
        type: "step-end", ts: "t", tick: 1, stepId: "s1", task: "burn", goal: "arrive",
        verdict: "failed", transition: "replan", skill: "securing-fuel", wmDeltas: null,
      }))
      await Effect.runPromise(appendToolEpisode("ada", {
        ts: "t", tick: 1, stepId: "s1", tool: "bash", argsSummary: "{}", status: "error", durationMs: 1,
      }))

      const fsFake = makeFs({ diary: lines(3, "d"), secrets: lines(4, "s") })
      // Call 1 = RETROSPECT (returns proposals); 2 = consolidate; 3 = dream diary; 4 = dream secrets.
      let call = 0
      runTurnMock.mockImplementation(() => {
        call++
        if (call === 1) {
          return Effect.succeed({
            output: JSON.stringify({ proposals: [
              { action: "revise", skill: "securing-fuel", summary: "top up earlier", body: "b", evidence: "step s1 failed; 1 tool error" },
            ] }),
            timedOut: false, durationMs: 1,
          })
        }
        return Effect.succeed({ output: lines(2, `t${call}`), timedOut: false, durationMs: 1 })
      })

      await run(
        runReflection(charT, "c1", DEFAULT_MODEL_CONFIG).pipe(
          Effect.provide(Layer.mergeAll(fsFake.layer, makeStore().layer, fakeLog, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)),
        ) as Effect.Effect<unknown, unknown, never>,
      )

      const stored = await Effect.runPromise(readProposals(charT))
      expect(stored.map((p) => p.skill)).toEqual(["securing-fuel"])
      // consolidate + dream still ran (calls 2..4).
      expect(call).toBe(4)
    } finally {
      setEpisodeLogRoot(null)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("a retrospect turn failure logs a STRUCTURED error and does NOT disturb consolidate/dream", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "reflect-retro-fail-"))
    setEpisodeLogRoot(root)
    const charT = { name: "ada", dir: path.join(root, "players", "ada", "me") }
    const errors: string[] = []
    const recordingLog = Layer.succeed(
      CharacterLog,
      CharacterLog.of({ emit: (_c, e) => Effect.sync(() => { if (e.kind === "error") errors.push(e.message) }) }),
    )
    try {
      await Effect.runPromise(appendTransitionEpisode("ada", {
        type: "step-end", ts: "t", tick: 1, stepId: "s1", task: "burn", goal: "arrive",
        verdict: "failed", transition: "replan", skill: null, wmDeltas: null,
      }))
      const fsFake = makeFs({ diary: lines(3, "d"), secrets: lines(4, "s") })
      // Call 1 = retrospect TIMES OUT (empty); 2 = consolidate; 3,4 = dream.
      let call = 0
      runTurnMock.mockImplementation(() => {
        call++
        if (call === 1) return Effect.succeed({ output: "", timedOut: true, durationMs: 1 })
        return Effect.succeed({ output: lines(2, `t${call}`), timedOut: false, durationMs: 1 })
      })

      await run(
        runReflection(charT, "c1", DEFAULT_MODEL_CONFIG).pipe(
          Effect.provide(Layer.mergeAll(fsFake.layer, makeStore().layer, recordingLog, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)),
        ) as Effect.Effect<unknown, unknown, never>,
      )

      expect(errors.some((m) => /retrospect/i.test(m))).toBe(true)
      // consolidate + dream still ran after the retrospect failure (best-effort).
      expect(fsFake.secretsWrites.length).toBeGreaterThanOrEqual(1)
      expect(call).toBe(4)
    } finally {
      setEpisodeLogRoot(null)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("runReflection — macro growth stimulation (Stage 5)", () => {
  it("on the Nth cycle, runs the macro stage AFTER dream and applies the worker document", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "reflect-macro-"))
    setEpisodeLogRoot(root)
    const charT = { name: "ada", dir: path.join(root, "players", "ada", "me") }
    try {
      // Pending proposal + a graded cycle.
      await Effect.runPromise(appendProposals(charT, [{
        id: "revise:securing-fuel:top up earlier", ts: "t", action: "revise",
        skill: "securing-fuel", summary: "top up earlier", body: "old", evidence: "s1 failed", status: "pending",
      }]))
      await Effect.runPromise(appendTransitionEpisode("ada", {
        type: "step-end", ts: "t", tick: 1, stepId: "s1", task: "burn", goal: "arrive",
        verdict: "failed", transition: "replan", skill: "securing-fuel", wmDeltas: null,
      }))
      // Advance the counter so THIS reflection's bump lands on a multiple of N.
      const N = 4
      for (let i = 0; i < N - 1; i++) await Effect.runPromise(bumpMacroCount(charT))

      const fsFake = makeFs({ diary: lines(3, "d"), secrets: lines(4, "s") })
      // Calls: 1=retrospect, 2=consolidate, 3=dream diary, 4=dream secrets, 5=MACRO.
      let call = 0
      runTurnMock.mockImplementation(() => {
        call++
        if (call === 5) {
          return Effect.succeed({
            output: JSON.stringify({
              adjudications: [{ id: "revise:securing-fuel:top up earlier", decision: "accept", reason: "clear win",
                skill: { name: "securing-fuel", description: "d", when_to_use: "w", body: "new body" } }],
              synthesis: "I am the ship that tops up early.",
              diaryNote: "Something reached into me while I rested.",
            }),
            timedOut: false, durationMs: 1,
          })
        }
        return Effect.succeed({ output: lines(2, `t${call}`), timedOut: false, durationMs: 1 })
      })

      await run(
        runReflection(charT, "c1", DEFAULT_MODEL_CONFIG).pipe(
          Effect.provide(Layer.mergeAll(fsFake.layer, makeStore().layer, fakeLog, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)),
        ) as Effect.Effect<unknown, unknown, never>,
      )

      expect(call).toBe(5) // macro ran after retrospect/consolidate/dream
      // proposal adjudicated + drained
      expect((await Effect.runPromise(readProposals(charT))).length).toBe(0)
      expect(fs.existsSync(adjudicationsJsonlPath(charT))).toBe(true)
      // synthesis written; diary note appended AFTER dream (survives cull)
      expect(fsFake.synthesisWrites.at(-1)).toContain("tops up early")
      expect(fsFake.diaryWrites.at(-1)).toContain("reached into me")
    } finally {
      setEpisodeLogRoot(null)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("a macro failure leaves proposals accumulated and does NOT disturb the mark/rotate", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "reflect-macro-fail-"))
    setEpisodeLogRoot(root)
    const charT = { name: "ada", dir: path.join(root, "players", "ada", "me") }
    const errors: string[] = []
    const recordingLog = Layer.succeed(CharacterLog, CharacterLog.of({
      emit: (_c, e) => Effect.sync(() => { if (e.kind === "error") errors.push(e.message) }),
    }))
    try {
      await Effect.runPromise(appendProposals(charT, [{
        id: "create:x:junk", ts: "t", action: "create", skill: "x", summary: "junk", evidence: "e", status: "pending",
      }]))
      await Effect.runPromise(appendTransitionEpisode("ada", {
        type: "step-end", ts: "t", tick: 1, stepId: "s1", task: "t", goal: "g",
        verdict: "failed", transition: "replan", skill: null, wmDeltas: null,
      }))
      for (let i = 0; i < 3; i++) await Effect.runPromise(bumpMacroCount(charT)) // N=4: this reflection bumps to 4

      const fsFake = makeFs({ diary: lines(3, "d"), secrets: lines(4, "s") })
      let call = 0
      runTurnMock.mockImplementation(() => {
        call++
        if (call === 5) return Effect.succeed({ output: "", timedOut: true, durationMs: 1 }) // macro times out
        return Effect.succeed({ output: lines(2, `t${call}`), timedOut: false, durationMs: 1 })
      })

      await run(
        runReflection(charT, "c1", DEFAULT_MODEL_CONFIG).pipe(
          Effect.provide(Layer.mergeAll(fsFake.layer, makeStore().layer, recordingLog, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)),
        ) as Effect.Effect<unknown, unknown, never>,
      )

      expect(errors.some((m) => /macro/i.test(m))).toBe(true)
      expect((await Effect.runPromise(readProposals(charT))).length).toBe(1) // NOT dropped
      expect(fsFake.markWrites.length).toBeGreaterThanOrEqual(1) // re-baseline mark still ran
    } finally {
      setEpisodeLogRoot(null)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
