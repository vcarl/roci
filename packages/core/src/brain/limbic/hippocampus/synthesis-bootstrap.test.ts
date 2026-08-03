import { describe, it, expect, vi, beforeEach } from "vitest"
import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { CommandExecutor } from "@effect/platform"

const { runTurnMock } = vi.hoisted(() => ({ runTurnMock: vi.fn() }))
vi.mock("../../../brain/stem/transport/process-runner.js", () => ({ runTurn: runTurnMock }))

import { bootstrapSynthesis, buildBootstrapPrompt } from "./synthesis-bootstrap.js"
import { MAX_SYNTHESIS_CHARS } from "./macro.js"
import { CharacterFs, CharacterFsError } from "../../../services/CharacterFs.js"
import { CharacterLog } from "../../../logging/log-writer.js"
import { OAuthToken } from "../../../services/OAuthToken.js"
import { DEFAULT_MODEL_CONFIG } from "../../../core/model-config.js"

const StubCommandExecutor = Layer.succeed(
  CommandExecutor.CommandExecutor,
  { start: () => { throw new Error("stub") } } as unknown as CommandExecutor.CommandExecutor,
)
const StubOAuthToken = Layer.succeed(
  OAuthToken,
  OAuthToken.of({ getToken: Effect.succeed({ token: "stub", version: 0 }), validateInContainer: () => Effect.succeed(true) }),
)

// In-memory CharacterFs stub — only the reads/writes bootstrap touches matter.
function fsLayer(state: {
  synthesis: { value: string }
  background: string
  values: string
  diary: string
  writeSynthesisFail?: CharacterFsError
}) {
  return Layer.succeed(CharacterFs, CharacterFs.of({
    readDiary: () => Effect.succeed(state.diary),
    writeDiary: () => Effect.void,
    readSecrets: () => Effect.succeed(""), writeSecrets: () => Effect.void,
    readBackground: () => Effect.succeed(state.background),
    readValues: () => Effect.succeed(state.values),
    readPalette: () => Effect.succeed(""), readDrives: () => Effect.succeed(""),
    readSalience: () => Effect.succeed(""),
    characterExists: () => Effect.succeed(true),
    listSkills: () => Effect.succeed([]), readSkill: () => Effect.succeed(null), writeSkill: () => Effect.void,
    readSynthesis: () => Effect.succeed(state.synthesis.value),
    writeSynthesis: (_c, v) =>
      state.writeSynthesisFail
        ? Effect.fail(state.writeSynthesisFail)
        : Effect.sync(() => { state.synthesis.value = v }),
    deleteSkill: () => Effect.void,
  }))
}
function logLayer(msgs: string[]) {
  return Layer.succeed(CharacterLog, CharacterLog.of({
    emit: (_c, e) => Effect.sync(() => { msgs.push((e as { message?: string }).message ?? "") }),
  }))
}
const deps = (state: Parameters<typeof fsLayer>[0], msgs: string[]) =>
  Layer.mergeAll(fsLayer(state), logLayer(msgs), NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)

const char = { name: "ada", root: "/tmp/does-not-matter/players/ada" }
const runExec = (state: Parameters<typeof fsLayer>[0], msgs: string[]) =>
  Effect.runPromise(
    bootstrapSynthesis
      .execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
      .pipe(Effect.provide(deps(state, msgs))) as Effect.Effect<{ bootstrapped: boolean }, never, never>,
  )

beforeEach(() => { runTurnMock.mockReset() })

describe("buildBootstrapPrompt", () => {
  it("embeds background/values/diary and asks for a memory index with retrieval pointers", () => {
    const p = buildBootstrapPrompt({ background: "BG", values: "VAL", diary: "DIARY" })
    for (const needle of ["BG", "VAL", "DIARY"]) expect(p).toContain(needle)
    // Framed as an INDEX over long-term memory with `memory search` retrieval hints.
    expect(p.toLowerCase()).toContain("index")
    expect(p).toContain("memory search")
  })

  it("forbids tools/files and frames the reply AS the artifact (bugfix: no Write-tool detour)", () => {
    const p = buildBootstrapPrompt({ background: "BG", values: "VAL", diary: "DIARY" })
    expect(p).toContain("Do NOT use any tools")
    expect(p.toLowerCase()).toContain("do not write any files")
    expect(p.toLowerCase()).toContain("verbatim")
  })

  it("does NOT use the old self-portrait framing (no self-model / who this character is / Write a SYNTHESIS.md)", () => {
    const p = buildBootstrapPrompt({ background: "BG", values: "VAL", diary: "DIARY" })
    expect(p).not.toContain("self-model")
    expect(p).not.toContain("who this character is")
    expect(p).not.toContain("Write a SYNTHESIS.md")
  })
})

describe("bootstrapSynthesis.execute", () => {
  it("absent/empty synthesis → runs the turn and writes the bounded memory index at the smart tier", async () => {
    const state = { synthesis: { value: "" }, background: "BG", values: "VAL", diary: "Day 1." }
    let modelUsed = ""
    runTurnMock.mockImplementation((cfg: { model: string }) => {
      modelUsed = cfg.model
      return Effect.succeed({ output: "I am Ada, and I am just beginning.", timedOut: false, durationMs: 1 })
    })
    const msgs: string[] = []
    const out = await runExec(state, msgs)

    expect(out.bootstrapped).toBe(true)
    expect(runTurnMock).toHaveBeenCalledTimes(1)
    expect(modelUsed).toBe("sonnet") // DEFAULT_MODEL_CONFIG smart tier — a bootstrap is a summarization
    expect(state.synthesis.value).toContain("I am Ada, and I am just beginning.")
  })

  it("present non-empty synthesis → no turn, no write (idempotent across sessions, gated on content)", async () => {
    const state = { synthesis: { value: "EXISTING SELF-MODEL" }, background: "BG", values: "VAL", diary: "Day 1." }
    runTurnMock.mockImplementation(() => Effect.succeed({ output: "should not run", timedOut: false, durationMs: 1 }))
    const msgs: string[] = []
    const out = await runExec(state, msgs)

    expect(out.bootstrapped).toBe(false)
    expect(runTurnMock).not.toHaveBeenCalled()
    expect(state.synthesis.value).toBe("EXISTING SELF-MODEL") // untouched
  })

  it("whitespace-only synthesis is treated as empty → the turn runs", async () => {
    const state = { synthesis: { value: "   \n\t" }, background: "BG", values: "VAL", diary: "Day 1." }
    runTurnMock.mockImplementation(() => Effect.succeed({ output: "A fresh self.", timedOut: false, durationMs: 1 }))
    const out = await runExec(state, [])
    expect(out.bootstrapped).toBe(true)
    expect(runTurnMock).toHaveBeenCalledTimes(1)
  })

  it("a timed-out turn writes nothing, logs an error, and never fails", async () => {
    const state = { synthesis: { value: "" }, background: "BG", values: "VAL", diary: "Day 1." }
    runTurnMock.mockImplementation(() => Effect.succeed({ output: "", timedOut: true, durationMs: 1 }))
    const msgs: string[] = []
    const out = await runExec(state, msgs)

    expect(out.bootstrapped).toBe(false)
    expect(state.synthesis.value).toBe("") // NOTHING written — placeholder keeps rendering
    expect(msgs.some((m) => /synthesis_bootstrap_failed/i.test(m))).toBe(true)
  })

  it("a thrown turn is caught (never-fail), nothing written", async () => {
    const state = { synthesis: { value: "" }, background: "BG", values: "VAL", diary: "Day 1." }
    runTurnMock.mockImplementation(() => Effect.fail(new Error("turn boom")))
    const msgs: string[] = []
    const out = await runExec(state, msgs)

    expect(out.bootstrapped).toBe(false)
    expect(state.synthesis.value).toBe("")
    expect(msgs.some((m) => /synthesis_bootstrap_failed/i.test(m))).toBe(true)
  })

  it("an empty-string (non-timeout) turn output writes nothing", async () => {
    const state = { synthesis: { value: "" }, background: "BG", values: "VAL", diary: "Day 1." }
    runTurnMock.mockImplementation(() => Effect.succeed({ output: "   ", timedOut: false, durationMs: 1 }))
    const out = await runExec(state, [])
    expect(out.bootstrapped).toBe(false)
    expect(state.synthesis.value).toBe("") // never a partial/empty file
  })

  it("a turn output wholly wrapped in a code fence is unwrapped before the write", async () => {
    const state = { synthesis: { value: "" }, background: "BG", values: "VAL", diary: "Day 1." }
    runTurnMock.mockImplementation(() =>
      Effect.succeed({ output: "```\nI am Ada, unfenced at last.\n```", timedOut: false, durationMs: 1 }),
    )
    const out = await runExec(state, [])
    expect(out.bootstrapped).toBe(true)
    expect(state.synthesis.value).toBe("I am Ada, unfenced at last.\n")
    expect(state.synthesis.value).not.toContain("```")
  })

  it("a language-tagged whole-output fence (```markdown) is unwrapped too", async () => {
    const state = { synthesis: { value: "" }, background: "BG", values: "VAL", diary: "Day 1." }
    runTurnMock.mockImplementation(() =>
      Effect.succeed({ output: "```markdown\nI am Ada.\n```", timedOut: false, durationMs: 1 }),
    )
    const out = await runExec(state, [])
    expect(out.bootstrapped).toBe(true)
    expect(state.synthesis.value).toBe("I am Ada.\n")
  })

  it("an INTERIOR fence in otherwise-unfenced prose is left untouched", async () => {
    const state = { synthesis: { value: "" }, background: "BG", values: "VAL", diary: "Day 1." }
    const prose = "I am Ada. I keep a habit:\n```\ncheck fuel\n```\nIt serves me."
    runTurnMock.mockImplementation(() => Effect.succeed({ output: prose, timedOut: false, durationMs: 1 }))
    const out = await runExec(state, [])
    expect(out.bootstrapped).toBe(true)
    expect(state.synthesis.value).toBe(`${prose}\n`) // verbatim + the writer's trailing newline
  })

  it("a wholly-fenced output that CONTAINS an interior fence keeps the interior one", async () => {
    const state = { synthesis: { value: "" }, background: "BG", values: "VAL", diary: "Day 1." }
    const inner = "I am Ada.\n```\ncheck fuel\n```\nIt serves me."
    runTurnMock.mockImplementation(() =>
      Effect.succeed({ output: `\`\`\`\n${inner}\n\`\`\``, timedOut: false, durationMs: 1 }),
    )
    const out = await runExec(state, [])
    expect(out.bootstrapped).toBe(true)
    expect(state.synthesis.value).toBe(`${inner}\n`) // outer unwrapped, interior intact
  })

  it("a bare empty fence (unwraps to nothing) writes nothing — never an empty file", async () => {
    const state = { synthesis: { value: "" }, background: "BG", values: "VAL", diary: "Day 1." }
    runTurnMock.mockImplementation(() => Effect.succeed({ output: "```\n```", timedOut: false, durationMs: 1 }))
    const msgs: string[] = []
    const out = await runExec(state, msgs)
    expect(out.bootstrapped).toBe(false)
    expect(state.synthesis.value).toBe("")
    expect(msgs.some((m) => /synthesis_bootstrap_failed/i.test(m))).toBe(true)
  })

  it("an over-bound turn output is discarded (never-grows), nothing written", async () => {
    const state = { synthesis: { value: "" }, background: "BG", values: "VAL", diary: "Day 1." }
    runTurnMock.mockImplementation(() =>
      Effect.succeed({ output: "x".repeat(MAX_SYNTHESIS_CHARS + 1), timedOut: false, durationMs: 1 }),
    )
    const msgs: string[] = []
    const out = await runExec(state, msgs)
    expect(out.bootstrapped).toBe(false)
    expect(state.synthesis.value).toBe("") // discarded — bound reused from macro
  })
})
