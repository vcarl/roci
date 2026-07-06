import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { CommandExecutor } from "@effect/platform"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const { runTurnMock } = vi.hoisted(() => ({ runTurnMock: vi.fn() }))
vi.mock("../hypothalamus/process-runner.js", () => ({ runTurn: runTurnMock }))

import { macro, buildMacroPrompt, defaultGrowthNote, renderMemoryHits, MAX_SYNTHESIS_CHARS } from "./macro.js"
import type { MemoryHit } from "../../../conscious/longterm-store.js"
import { CharacterFs, CharacterFsError } from "../../../services/CharacterFs.js"
import type { SkillDoc } from "../../../services/skills-core.js"
import { CharacterLog } from "../../../logging/log-writer.js"
import { OAuthToken } from "../../../services/OAuthToken.js"
import { LongtermStore } from "../../../conscious/longterm-store.js"
import { DEFAULT_MODEL_CONFIG } from "../../model-config.js"
import { setEpisodeLogRoot, appendToolEpisode, appendTransitionEpisode } from "../../../logging/episodes.js"
import {
  appendProposals, readProposals, bumpMacroCount, macroStatePath, adjudicationsJsonlPath,
  type SkillProposal,
} from "../../../conscious/growth-store.js"

const StubCommandExecutor = Layer.succeed(
  CommandExecutor.CommandExecutor,
  { start: () => { throw new Error("stub") } } as unknown as CommandExecutor.CommandExecutor,
)
const StubOAuthToken = Layer.succeed(
  OAuthToken,
  OAuthToken.of({ getToken: Effect.succeed({ token: "stub", version: 0 }), validateInContainer: () => Effect.succeed(true) }),
)
// LongtermStore stub: recall returns nothing unless a test overrides it.
const stubStore = (recall: (typeof LongtermStore.Service)["recall"] = () => Effect.succeed([])) =>
  Layer.succeed(LongtermStore, LongtermStore.of({
    readMark: () => Effect.succeed(null), writeMark: () => Effect.void,
    promote: () => Effect.succeed(0), remember: () => Effect.void, recall,
  } as unknown as typeof LongtermStore.Service))

// In-memory CharacterFs stub that records skill writes/deletes, synthesis, diary.
function fsLayer(state: {
  skills: Map<string, { name: string; description: string; whenToUse: string; body: string }>
  synthesis: { value: string }
  diary: { value: string }
  // Optional writeSkill override — return a CharacterFsError to simulate a
  // cap (kind:"validation") or transient (kind:"io") write failure.
  writeSkillFail?: CharacterFsError
  // Optional deleteSkill override — simulate a transient fs.remove failure.
  deleteSkillFail?: CharacterFsError
}) {
  return Layer.succeed(CharacterFs, CharacterFs.of({
    readDiary: () => Effect.succeed(state.diary.value),
    writeDiary: (_c, v) => Effect.sync(() => { state.diary.value = v }),
    readSecrets: () => Effect.succeed(""), writeSecrets: () => Effect.void,
    readCredentials: () => Effect.succeed({ username: "", password: "" }),
    readBackground: () => Effect.succeed("BG"), readValues: () => Effect.succeed("VAL"),
    readPalette: () => Effect.succeed(""), readDrives: () => Effect.succeed(""),
    characterExists: () => Effect.succeed(true),
    listSkills: () => Effect.succeed([...state.skills.entries()].map(([slug, s]) => ({ slug, ...s }))),
    readSkill: () => Effect.succeed(null),
    writeSkill: (_c, doc: SkillDoc) =>
      state.writeSkillFail
        ? Effect.fail(state.writeSkillFail)
        : Effect.sync(() => { state.skills.set(doc.slug, { name: doc.name, description: doc.description, whenToUse: doc.whenToUse, body: doc.body }) }),
    readSynthesis: () => Effect.succeed(state.synthesis.value),
    writeSynthesis: (_c, v) => Effect.sync(() => { state.synthesis.value = v }),
    deleteSkill: (_c, name) =>
      state.deleteSkillFail
        ? Effect.fail(state.deleteSkillFail)
        : Effect.sync(() => { state.skills.delete(name) }),
  }))
}
// Captures EVERY emitted message (any kind) so both kind:"error" (logError) and
// kind:"system"/"warn" (logToConsole) lines are assertable in one array.
function logLayer(errors: string[]) {
  return Layer.succeed(CharacterLog, CharacterLog.of({
    emit: (_c, e) => Effect.sync(() => { errors.push((e as { message?: string }).message ?? "") }),
  }))
}
const deps = (state: Parameters<typeof fsLayer>[0], errors: string[], store = stubStore()) =>
  Layer.mergeAll(fsLayer(state), logLayer(errors), store, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)

let root: string
let char: { name: string; dir: string }
let state: Parameters<typeof fsLayer>[0]
beforeEach(() => {
  runTurnMock.mockReset()
  root = fs.mkdtempSync(path.join(os.tmpdir(), "macro-"))
  char = { name: "ada", dir: path.join(root, "players", "ada", "me") }
  state = { skills: new Map(), synthesis: { value: "" }, diary: { value: "Day 1." } }
  setEpisodeLogRoot(root)
})
afterEach(() => { setEpisodeLogRoot(null); fs.rmSync(root, { recursive: true, force: true }) })

const run = <A>(eff: Effect.Effect<A, never, never>) => Effect.runPromise(eff)
const N = 4

const seedPendingAndCycle = async () => {
  const prop: SkillProposal = {
    id: "revise:securing-fuel:top up earlier", ts: "t", action: "revise",
    skill: "securing-fuel", summary: "top up earlier", body: "old", evidence: "s1 failed", status: "pending",
  }
  await run(appendProposals(char, [prop]))
  await run(appendTransitionEpisode("ada", {
    type: "step-end", ts: "t", tick: 1, stepId: "s1", task: "burn to Kepler", goal: "arrive",
    verdict: "failed", transition: "replan", skill: "securing-fuel", wmDeltas: null,
  }))
  await run(appendToolEpisode("ada", { ts: "t", tick: 1, stepId: "s1", tool: "bash", argsSummary: "{}", status: "error", durationMs: 1 }))
}
const bumpTo = async (n: number) => { for (let i = 0; i < n; i++) await run(bumpMacroCount(char)) }

describe("buildMacroPrompt / defaultGrowthNote", () => {
  it("embeds inputs, frames the superintelligence, and demands the JSON contract", () => {
    const p = buildMacroPrompt({ index: "IDX", pending: "PEND", aggregate: "AGG", sample: "SAMP", memory: "MEM", synthesis: "SYN" })
    for (const needle of ["IDX", "PEND", "AGG", "SAMP", "MEM", "SYN", "adjudications", "synthesis", "diaryNote", "evidence"]) {
      expect(p).toContain(needle)
    }
  })
  it("frames SYNTHESIS.md as a memory index over long-term memory, not a self-portrait", () => {
    const p = buildMacroPrompt({ index: "IDX", pending: "PEND", aggregate: "AGG", sample: "SAMP", memory: "MEM", synthesis: "SYN" })
    // Task 2 asks for an INDEX with `memory search` retrieval pointers…
    expect(p.toLowerCase()).toContain("memory index")
    expect(p).toContain("memory search")
    // …and drops the old first-person self-portrait framing.
    expect(p).not.toContain("self-model")
    expect(p).not.toContain("who this character is")
    expect(p).not.toContain("first-person account")
  })
  it("defaultGrowthNote is character-facing in-fiction growth-stimulation prose", () => {
    const note = defaultGrowthNote({ accepted: 2, rejected: 1, synthesized: true })
    expect(note.toLowerCase()).toContain("growth")
  })
})

describe("renderMemoryHits", () => {
  const hit = (over: Partial<MemoryHit>): MemoryHit => ({
    id: 1, ts: "t", source: "promotion", tags: [], text: "a memory", score: 0.5, ...over,
  })
  it("surfaces each hit's source and tags alongside the text (real retrieval keys for the index)", () => {
    const out = renderMemoryHits([
      hit({ source: "reflection", tags: ["fuel", "kepler"], text: "topped up before the burn" }),
    ])
    expect(out).toContain("reflection") // source
    expect(out).toContain("fuel") // tag
    expect(out).toContain("kepler") // tag
    expect(out).toContain("topped up before the burn") // text
  })
  it("empty → honest placeholder", () => {
    expect(renderMemoryHits([])).toContain("no long-term memories")
  })
})

describe("macro.execute — counter gate", () => {
  it("fails closed (does not run the turn) when the growth dir is unwritable — count stays at the 0 sentinel", async () => {
    fs.writeFileSync(path.join(root, "players"), "not a directory") // mkdir -p under here will fail
    runTurnMock.mockImplementation(() => Effect.succeed({ output: "should not run", timedOut: false, durationMs: 1 }))
    const errors: string[] = []
    const out = await run(macro.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
      .pipe(Effect.provide(deps(state, errors))) as Effect.Effect<any, never, never>)
    expect(out.ran).toBe(false)
    expect(runTurnMock).not.toHaveBeenCalled()
  })

  it("does not run the turn on a non-Nth cycle; bumps the counter", async () => {
    await seedPendingAndCycle()
    await bumpTo(1) // count now 1 (macro will bump to 2 → 2 % 4 !== 0)
    const errors: string[] = []
    const out = await run(macro.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
      .pipe(Effect.provide(deps(state, errors))) as Effect.Effect<any, never, never>)
    expect(out.ran).toBe(false)
    expect(runTurnMock).not.toHaveBeenCalled()
    // proposals untouched
    expect((await run(readProposals(char))).length).toBe(1)
  })
})

describe("macro.execute — the Nth cycle applies the worker's document", () => {
  beforeEach(async () => { await seedPendingAndCycle(); await bumpTo(N - 1) }) // macro bump → N → runs

  it("accepts a revise (writeSkill), records the audit, drains the queue, writes synthesis, appends diary", async () => {
    runTurnMock.mockImplementation(() => Effect.succeed({
      output: JSON.stringify({
        adjudications: [
          { id: "revise:securing-fuel:top up earlier", decision: "accept", reason: "clear win",
            skill: { name: "securing-fuel", description: "reliable top-ups", when_to_use: "below a third", body: "top up before every burn" } },
        ],
        synthesis: "I am the ship that tops up early.",
        diaryNote: "Something reached into me while I rested, and set my fuel habit straight.",
      }),
      timedOut: false, durationMs: 1,
    }))
    const errors: string[] = []
    const out = await run(macro.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
      .pipe(Effect.provide(deps(state, errors))) as Effect.Effect<any, never, never>)
    expect(out).toMatchObject({ ran: true, accepted: 1, rejected: 0, synthesized: true, narrated: true })
    expect(state.skills.get("securing-fuel")?.body).toBe("top up before every burn")
    expect(state.synthesis.value).toContain("tops up early")
    expect(state.diary.value).toContain("reached into me")
    // queue drained
    expect((await run(readProposals(char))).length).toBe(0)
    // audit recorded
    const audit = fs.readFileSync(adjudicationsJsonlPath(char), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ decision: "accepted", skill: "securing-fuel" })
  })

  it("records a rejected proposal with its reason and drains it, without a skill write", async () => {
    runTurnMock.mockImplementation(() => Effect.succeed({
      output: JSON.stringify({
        adjudications: [{ id: "revise:securing-fuel:top up earlier", decision: "reject", reason: "one failure is not a pattern" }],
        synthesis: "", diaryNote: "",
      }),
      timedOut: false, durationMs: 1,
    }))
    const errors: string[] = []
    const out = await run(macro.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
      .pipe(Effect.provide(deps(state, errors))) as Effect.Effect<any, never, never>)
    expect(out).toMatchObject({ ran: true, accepted: 0, rejected: 1 })
    expect(state.skills.size).toBe(0)
    expect((await run(readProposals(char))).length).toBe(0)
    const audit = fs.readFileSync(adjudicationsJsonlPath(char), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    expect(audit[0]).toMatchObject({ decision: "rejected", reason: "one failure is not a pattern" })
  })

  it("discards an over-bound synthesis (never-grows), keeping the prior SYNTHESIS.md", async () => {
    state.synthesis.value = "PRIOR"
    runTurnMock.mockImplementation(() => Effect.succeed({
      output: JSON.stringify({ adjudications: [], synthesis: "x".repeat(MAX_SYNTHESIS_CHARS + 1), diaryNote: "note" }),
      timedOut: false, durationMs: 1,
    }))
    const errors: string[] = []
    const out = await run(macro.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
      .pipe(Effect.provide(deps(state, errors))) as Effect.Effect<any, never, never>)
    expect(out.synthesized).toBe(false)
    expect(state.synthesis.value).toBe("PRIOR") // untouched
  })

  it("a blank/timed-out turn leaves proposals accumulated and never fails", async () => {
    runTurnMock.mockImplementation(() => Effect.succeed({ output: "", timedOut: true, durationMs: 1 }))
    const errors: string[] = []
    const out = await run(macro.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
      .pipe(Effect.provide(deps(state, errors))) as Effect.Effect<any, never, never>)
    expect(out).toMatchObject({ ran: true, accepted: 0, synthesized: false })
    expect((await run(readProposals(char))).length).toBe(1) // NOT dropped
    expect(errors.some((m) => /macro/i.test(m))).toBe(true)
  })

  it("a thrown turn is caught (never-fail), proposals survive", async () => {
    runTurnMock.mockImplementation(() => Effect.fail(new Error("turn boom")))
    const errors: string[] = []
    const out = await run(macro.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
      .pipe(Effect.provide(deps(state, errors))) as Effect.Effect<any, never, never>)
    expect(out.ran).toBe(true)
    expect((await run(readProposals(char))).length).toBe(1)
    expect(errors.some((m) => /macro/i.test(m))).toBe(true)
  })

  // Follow-up 1: a TRANSIENT writeSkill IO failure must NOT be conflated with a
  // deterministic cap rejection.
  it("a transient (kind:io) writeSkill failure leaves the proposal PENDING — not audited, not drained (follow-up 1)", async () => {
    state.writeSkillFail = new CharacterFsError("disk gone", undefined, "io")
    runTurnMock.mockImplementation(() => Effect.succeed({
      output: JSON.stringify({
        adjudications: [
          { id: "revise:securing-fuel:top up earlier", decision: "accept", reason: "clear win",
            skill: { name: "securing-fuel", description: "d", when_to_use: "w", body: "top up before every burn" } },
        ],
        synthesis: "", diaryNote: "",
      }),
      timedOut: false, durationMs: 1,
    }))
    const errors: string[] = []
    const out = await run(macro.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
      .pipe(Effect.provide(deps(state, errors))) as Effect.Effect<any, never, never>)
    expect(out).toMatchObject({ ran: true, accepted: 0, rejected: 0 })
    expect((await run(readProposals(char))).length).toBe(1) // NOT drained — retried next cycle
    expect(fs.existsSync(adjudicationsJsonlPath(char))).toBe(false) // NOT audited
    expect(errors.some((m) => /io_failed/i.test(m))).toBe(true)
  })

  it("a deterministic (kind:validation) writeSkill failure IS recorded rejected and drained (follow-up 1)", async () => {
    state.writeSkillFail = new CharacterFsError("skill cap reached (12); revise or retire an existing skill", undefined, "validation")
    runTurnMock.mockImplementation(() => Effect.succeed({
      output: JSON.stringify({
        adjudications: [
          { id: "revise:securing-fuel:top up earlier", decision: "accept", reason: "clear win",
            skill: { name: "securing-fuel", description: "d", when_to_use: "w", body: "top up before every burn" } },
        ],
        synthesis: "", diaryNote: "",
      }),
      timedOut: false, durationMs: 1,
    }))
    const errors: string[] = []
    const out = await run(macro.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
      .pipe(Effect.provide(deps(state, errors))) as Effect.Effect<any, never, never>)
    expect(out).toMatchObject({ ran: true, accepted: 0, rejected: 1 })
    expect((await run(readProposals(char))).length).toBe(0) // drained — a real rejection
    const audit = fs.readFileSync(adjudicationsJsonlPath(char), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    expect(audit[0]).toMatchObject({ decision: "rejected" })
    expect(audit[0].reason).toContain("skill write rejected")
  })

  // Follow-up 3: an accepted create/revise whose worker doc has no usable
  // name+body must not write a near-empty skill; it is left pending.
  it("an accepted create with no skill object and no proposal body is left pending, never written (follow-up 3)", async () => {
    await run(appendProposals(char, [{
      id: "create:new-skill:do the thing", ts: "t", action: "create",
      skill: "new-skill", summary: "do the thing", evidence: "s1 failed", status: "pending",
    }]))
    runTurnMock.mockImplementation(() => Effect.succeed({
      output: JSON.stringify({
        adjudications: [{ id: "create:new-skill:do the thing", decision: "accept", reason: "ok" }], // no skill object
        synthesis: "", diaryNote: "",
      }),
      timedOut: false, durationMs: 1,
    }))
    const errors: string[] = []
    const out = await run(macro.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
      .pipe(Effect.provide(deps(state, errors))) as Effect.Effect<any, never, never>)
    expect(out).toMatchObject({ ran: true, accepted: 0, rejected: 0 })
    expect(state.skills.size).toBe(0) // no near-empty skill written
    // Both proposals survive (the incomplete-accept one is NOT drained).
    const ids = (await run(readProposals(char))).map((p) => p.id)
    expect(ids).toContain("create:new-skill:do the thing")
    expect(errors.some((m) => /incomplete_accept/i.test(m))).toBe(true)
    expect(fs.existsSync(adjudicationsJsonlPath(char))).toBe(false) // nothing audited
  })

  // Follow-up 5: verdict ids matching no pending proposal are warned, not silent.
  it("warns on hallucinated adjudication ids while still applying the real ruling (follow-up 5)", async () => {
    runTurnMock.mockImplementation(() => Effect.succeed({
      output: JSON.stringify({
        adjudications: [
          { id: "ghost:made-up:nonsense", decision: "reject", reason: "hallucinated" },
          { id: "revise:securing-fuel:top up earlier", decision: "accept", reason: "clear win",
            skill: { name: "securing-fuel", description: "d", when_to_use: "w", body: "top up before every burn" } },
        ],
        synthesis: "", diaryNote: "",
      }),
      timedOut: false, durationMs: 1,
    }))
    const errors: string[] = []
    const out = await run(macro.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
      .pipe(Effect.provide(deps(state, errors))) as Effect.Effect<any, never, never>)
    expect(out).toMatchObject({ ran: true, accepted: 1 })
    expect(state.skills.get("securing-fuel")?.body).toBe("top up before every burn")
    expect(errors.some((m) => /unknown_adjudication_ids/i.test(m) && /ghost:made-up:nonsense/.test(m))).toBe(true)
    // Only the real proposal was drained; the ghost id never touched the queue.
    expect((await run(readProposals(char))).length).toBe(0)
  })

  // Review finding: the retire path must keep the same loss-aversion symmetry as
  // writeSkill — a transient deleteSkill failure must not audit "accepted" and
  // drain while the skill file survives on disk.
  it("a transient deleteSkill failure on an accepted retire leaves the proposal PENDING — not audited, not drained", async () => {
    state.deleteSkillFail = new CharacterFsError("Failed to delete skill", undefined, "io")
    state.skills.set("stale-skill", { name: "stale-skill", description: "d", whenToUse: "w", body: "b" })
    await run(appendProposals(char, [{
      id: "retire:stale-skill:unused all cycle", ts: "t", action: "retire",
      skill: "stale-skill", summary: "unused all cycle", evidence: "0 steps worn", status: "pending",
    }]))
    runTurnMock.mockImplementation(() => Effect.succeed({
      output: JSON.stringify({
        adjudications: [{ id: "retire:stale-skill:unused all cycle", decision: "accept", reason: "dead weight" }],
        synthesis: "", diaryNote: "",
      }),
      timedOut: false, durationMs: 1,
    }))
    const errors: string[] = []
    const out = await run(macro.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
      .pipe(Effect.provide(deps(state, errors))) as Effect.Effect<any, never, never>)
    expect(out).toMatchObject({ ran: true, accepted: 0, rejected: 0 })
    expect(state.skills.has("stale-skill")).toBe(true) // file survived — retire did NOT happen
    // Proposal NOT drained (still pending, alongside the seeded revise one).
    const ids = (await run(readProposals(char))).map((p) => p.id)
    expect(ids).toContain("retire:stale-skill:unused all cycle")
    expect(fs.existsSync(adjudicationsJsonlPath(char))).toBe(false) // NOT audited as accepted
    expect(errors.some((m) => /delete_io_failed/i.test(m))).toBe(true)
  })

  // Review nit: duplicate ids in the worker doc must not double-audit or inflate counts.
  it("duplicate decision ids in the worker doc are processed once — one audit row, counts not inflated", async () => {
    runTurnMock.mockImplementation(() => Effect.succeed({
      output: JSON.stringify({
        adjudications: [
          { id: "revise:securing-fuel:top up earlier", decision: "accept", reason: "clear win",
            skill: { name: "securing-fuel", description: "d", when_to_use: "w", body: "top up before every burn" } },
          { id: "revise:securing-fuel:top up earlier", decision: "reject", reason: "contradictory duplicate" },
        ],
        synthesis: "", diaryNote: "",
      }),
      timedOut: false, durationMs: 1,
    }))
    const errors: string[] = []
    const out = await run(macro.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
      .pipe(Effect.provide(deps(state, errors))) as Effect.Effect<any, never, never>)
    expect(out).toMatchObject({ ran: true, accepted: 1, rejected: 0 }) // first ruling wins, no inflation
    expect(state.skills.get("securing-fuel")?.body).toBe("top up before every burn")
    const audit = fs.readFileSync(adjudicationsJsonlPath(char), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    expect(audit).toHaveLength(1) // exactly one row for the id
    expect(audit[0]).toMatchObject({ decision: "accepted" })
    expect((await run(readProposals(char))).length).toBe(0)
  })
})
