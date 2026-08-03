import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { CommandExecutor } from "@effect/platform"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const { runTurnMock } = vi.hoisted(() => ({ runTurnMock: vi.fn() }))
vi.mock("../../../brain/stem/transport/process-runner.js", () => ({ runTurn: runTurnMock }))

import { retrospect, buildRetrospectPrompt } from "./retrospect.js"
import { CharacterFs } from "../../../services/CharacterFs.js"
import { CharacterLog } from "../../../logging/log-writer.js"
import { OAuthToken } from "../../../services/OAuthToken.js"
import { DEFAULT_MODEL_CONFIG } from "../../../core/model-config.js"
import { appendToolEpisode, appendTransitionEpisode } from "../../../logging/episodes.js"
import { readProposals, proposalsJsonlPath } from "./growth-store.js"

const StubCommandExecutor = Layer.succeed(
  CommandExecutor.CommandExecutor,
  { start: () => { throw new Error("stub") } } as unknown as CommandExecutor.CommandExecutor,
)
const StubOAuthToken = Layer.succeed(
  OAuthToken,
  OAuthToken.of({ getToken: Effect.succeed({ token: "stub", version: 0 }), validateInContainer: () => Effect.succeed(true) }),
)

function fsLayer(skills: Array<{ slug: string; name: string; description: string; whenToUse: string }>) {
  return Layer.succeed(
    CharacterFs,
    CharacterFs.of({
      readDiary: () => Effect.succeed(""), writeDiary: () => Effect.void,
      readSecrets: () => Effect.succeed(""), writeSecrets: () => Effect.void,
      readBackground: () => Effect.succeed(""), readValues: () => Effect.succeed(""),
      readPalette: () => Effect.succeed(""), readDrives: () => Effect.succeed(""),
      readSalience: () => Effect.succeed(""),
      characterExists: () => Effect.succeed(true),
      listSkills: () => Effect.succeed(skills),
      readSkill: () => Effect.succeed(null), writeSkill: () => Effect.void,
      readSynthesis: () => Effect.succeed(""), writeSynthesis: () => Effect.void, deleteSkill: () => Effect.void,
    }),
  )
}
function logLayer(errors: string[], system: string[] = []) {
  return Layer.succeed(
    CharacterLog,
    CharacterLog.of({ emit: (_c, e) => Effect.sync(() => {
      if (e.kind === "error") errors.push(e.message)
      else if (e.kind === "system") system.push(e.message)
    }) }),
  )
}

let root: string
let char: { name: string; root: string }
beforeEach(() => {
  runTurnMock.mockReset()
  root = fs.mkdtempSync(path.join(os.tmpdir(), "retro-"))
  char = { name: "ada", root: path.join(root, "players", "ada") }
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const seedCurrentCycle = async () => {
  await Effect.runPromise(appendTransitionEpisode(char, {
    type: "step-end", ts: "t", tick: 1, stepId: "s1", task: "burn to Kepler", goal: "arrive",
    verdict: "failed", transition: "replan", skill: "securing-fuel", wmDeltas: null,
  }))
  await Effect.runPromise(appendToolEpisode(char, {
    ts: "t", tick: 1, stepId: "s1", tool: "bash", argsSummary: "{}", status: "error", durationMs: 1,
  }))
}

const deps = (skills: Parameters<typeof fsLayer>[0], errors: string[], system: string[] = []) =>
  Layer.mergeAll(fsLayer(skills), logLayer(errors, system), NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)

describe("buildRetrospectPrompt", () => {
  it("embeds the skill index, aggregate, sample, and transition digest, and demands evidence + JSON output", () => {
    const p = buildRetrospectPrompt({
      index: "SKILL_INDEX",
      aggregate: "AGG_BLOCK",
      sample: "SAMPLE_BLOCK",
      activity: "ACTIVITY_BLOCK",
    })
    expect(p).toContain("SKILL_INDEX")
    expect(p).toContain("AGG_BLOCK")
    expect(p).toContain("SAMPLE_BLOCK")
    expect(p).toContain("ACTIVITY_BLOCK")
    expect(p).toContain("evidence")
    expect(p).toContain("proposals")
  })

  it("renders a worked example in the real stepId format and directive (not purely threatening) framing", () => {
    const p = buildRetrospectPrompt({ index: "I", aggregate: "A", sample: "S", activity: "V" })
    // A single worked example: a step id in the c<epoch>-s<tick>-<n> form with a
    // realistic small epoch, an obviously-placeholder skill name, and an explicit
    // do-not-reuse warning (echo hazard for a small model).
    expect(p).toContain("Worked example")
    expect(p).toContain("c3-s16-1")
    expect(p).toContain("example-skill-name")
    expect(p).toContain("reuse its skill name, step id, or content")
    // Directive framing: when there are completed steps, aim for 1-3 proposals…
    expect(p).toContain("aim for 1 to 3 proposals")
    // …and the old purely-threatening line is gone (the evidence bar is kept, reframed).
    expect(p).not.toContain("will be thrown away")
  })
})

describe("retrospect.execute", () => {
  it("does NOT run a turn when the cycle produced no episodes", async () => {
    const errors: string[] = []
    const out = await Effect.runPromise(
      retrospect.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
        .pipe(Effect.provide(deps([], errors))) as Effect.Effect<{ proposals: number }, never, never>,
    )
    expect(out.proposals).toBe(0)
    expect(runTurnMock).not.toHaveBeenCalled()
  })

  it("grades the cycle and appends evidence-bearing proposals; drops evidence-less ones", async () => {
    await seedCurrentCycle()
    runTurnMock.mockImplementation(() =>
      Effect.succeed({
        output: JSON.stringify({
          proposals: [
            { action: "revise", skill: "securing-fuel", summary: "Top up earlier", body: "b", evidence: "step s1 failed; 1 tool error" },
            { action: "create", skill: "no-evidence", summary: "junk", evidence: "" }, // dropped
          ],
        }),
        timedOut: false, durationMs: 1,
      }),
    )
    const errors: string[] = []
    const out = await Effect.runPromise(
      retrospect.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
        .pipe(Effect.provide(deps([{ slug: "securing-fuel", name: "securing-fuel", description: "fuel", whenToUse: "low fuel" }], errors))) as Effect.Effect<{ proposals: number }, never, never>,
    )
    expect(out.proposals).toBe(1)
    expect(fs.existsSync(proposalsJsonlPath(char))).toBe(true)
    const stored = await Effect.runPromise(readProposals(char))
    expect(stored.map((p) => p.skill)).toEqual(["securing-fuel"])
    expect(stored[0].evidence.length).toBeGreaterThan(0)
  })

  it("feeds the full-fidelity tier + wm records (not just aggregates) into the turn prompt", async () => {
    // Reproduces the write-only-stream bug (10879c6): a cycle whose signal lives in
    // the tier/wm records — a long step that surfaced a server bug — must reach the
    // retrospect turn, not just the aggregate counts. A completed step always emits
    // a step-end (the boundary that passes the skip gate); the value the turn needs
    // beyond the counts is in the evaluate output + wm deltas, which the digest
    // projection carries.
    await Effect.runPromise(appendTransitionEpisode(char, {
      type: "step-end", ts: "t", tick: 4, stepId: "c1-s4-0", task: "long investigation", goal: "g",
      verdict: "failed", transition: "replan", skill: null, wmDeltas: null,
    }))
    await Effect.runPromise(appendTransitionEpisode(char, {
      type: "tier", ts: "t", tick: 4, stepId: "c1-s4-0", phase: "evaluate",
      prompt: "HUGE_RAW_PROMPT_SHOULD_NOT_LEAK", output: { judgment: "failed", reasoning: "GAME_SERVER_BUG_DISCOVERED" },
    }))
    await Effect.runPromise(appendTransitionEpisode(char, {
      type: "tier", ts: "t", tick: 2, stepId: "c1-s2-0", phase: "orient",
      orientKind: "steer", prompt: "P", output: { headline: "STEER_HEADLINE" },
    }))
    await Effect.runPromise(appendTransitionEpisode(char, {
      type: "wm", ts: "t", tick: 4, stepId: "c1-s4-0", deltas: [{ verb: "add", id: "t9", text: "WM_NOTE_BUG" }],
    }))
    let capturedPrompt = ""
    runTurnMock.mockImplementation((args: { prompt: string }) => {
      capturedPrompt = args.prompt
      return Effect.succeed({ output: JSON.stringify({ proposals: [] }), timedOut: false, durationMs: 1 })
    })
    const errors: string[] = []
    await Effect.runPromise(
      retrospect.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
        .pipe(Effect.provide(deps([], errors))) as Effect.Effect<{ proposals: number }, never, never>,
    )
    expect(runTurnMock).toHaveBeenCalled()
    // Parsed outputs + wm activity + the orient discriminator are present…
    expect(capturedPrompt).toContain("GAME_SERVER_BUG_DISCOVERED")
    expect(capturedPrompt).toContain("STEER_HEADLINE")
    expect(capturedPrompt).toContain("orient/steer")
    expect(capturedPrompt).toContain("WM_NOTE_BUG")
    // …but the raw rendered prompt blob is NEVER leaked into the digest.
    expect(capturedPrompt).not.toContain("HUGE_RAW_PROMPT_SHOULD_NOT_LEAK")
  })

  it("a blank/timed-out turn appends nothing and never fails", async () => {
    await seedCurrentCycle()
    runTurnMock.mockImplementation(() => Effect.succeed({ output: "", timedOut: true, durationMs: 1 }))
    const errors: string[] = []
    const out = await Effect.runPromise(
      retrospect.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
        .pipe(Effect.provide(deps([], errors))) as Effect.Effect<{ proposals: number }, never, never>,
    )
    expect(out.proposals).toBe(0)
    expect(fs.existsSync(proposalsJsonlPath(char))).toBe(false)
    expect(errors.some((m) => /retrospect/i.test(m))).toBe(true)
  })

  it("a thrown turn is caught (never-fail) and appends nothing", async () => {
    await seedCurrentCycle()
    runTurnMock.mockImplementation(() => Effect.fail(new Error("turn boom")))
    const errors: string[] = []
    const out = await Effect.runPromise(
      retrospect.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
        .pipe(Effect.provide(deps([], errors))) as Effect.Effect<{ proposals: number }, never, never>,
    )
    expect(out.proposals).toBe(0)
    expect(errors.some((m) => /retrospect/i.test(m))).toBe(true)
  })

  // A fixture approximating today's cycle-2 shape: two completed steps (one a long
  // step whose evaluate output surfaced the Markeb-market fabrication), tool
  // episodes, and tier/wm digest entries. Model behavior isn't assertable in a
  // unit test (that's the live-validation phase), but the prompt CONTENT is: the
  // worked example, the transition digest, and the directive framing must render.
  const seedCycle2 = async () => {
    // Two completed steps (step-ends → gate passes, and they set "completed steps").
    await Effect.runPromise(appendTransitionEpisode(char, {
      type: "step-end", ts: "t", tick: 3, stepId: "c2-s3-0", task: "scan nearby stations", goal: "locate a market",
      verdict: "succeeded", transition: "next_step", skill: "surveying-systems", wmDeltas: null,
    }))
    await Effect.runPromise(appendTransitionEpisode(char, {
      type: "step-end", ts: "t", tick: 26, stepId: "c2-s26-1", task: "trade at the Markeb market board", goal: "sell ore",
      verdict: "failed", transition: "replan", skill: "trading-ore", wmDeltas: null,
    }))
    // The long step's evaluate output carries the discovery (digest, not aggregate).
    await Effect.runPromise(appendTransitionEpisode(char, {
      type: "tier", ts: "t", tick: 26, stepId: "c2-s26-1", phase: "evaluate",
      prompt: "RAW_EVAL_PROMPT_MUST_NOT_LEAK",
      output: { judgment: "failed", reasoning: "the Markeb market board does not exist — it is a fabrication; no such station is here" },
    }))
    await Effect.runPromise(appendTransitionEpisode(char, {
      type: "wm", ts: "t", tick: 26, stepId: "c2-s26-1", deltas: [{ verb: "add", id: "t3", text: "Markeb market is fabricated" }],
    }))
    // Tool episodes joined to the long step.
    await Effect.runPromise(appendToolEpisode(char, { ts: "t", tick: 26, stepId: "c2-s26-1", tool: "sm", argsSummary: "{}", status: "error", durationMs: 1 }))
    await Effect.runPromise(appendToolEpisode(char, { ts: "t", tick: 26, stepId: "c2-s26-1", tool: "bash", argsSummary: "{}", status: "completed", durationMs: 1 }))
  }

  it("renders the worked example, the transition digest, and directive framing on a cycle-2-shaped fixture", async () => {
    await seedCycle2()
    let capturedPrompt = ""
    runTurnMock.mockImplementation((args: { prompt: string }) => {
      capturedPrompt = args.prompt
      return Effect.succeed({ output: JSON.stringify({ proposals: [] }), timedOut: false, durationMs: 1 })
    })
    const errors: string[] = []
    await Effect.runPromise(
      retrospect.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
        .pipe(Effect.provide(deps([{ slug: "trading-ore", name: "trading-ore", description: "trade", whenToUse: "at a market" }], errors))) as Effect.Effect<{ proposals: number }, never, never>,
    )
    expect(runTurnMock).toHaveBeenCalled()
    // The worked example (real stepId form + placeholder skill name).
    expect(capturedPrompt).toContain("c3-s16-1")
    expect(capturedPrompt).toContain("example-skill-name")
    // The transition digest carries the long step's discovery — but never the raw prompt blob.
    expect(capturedPrompt).toContain("it is a fabrication")
    expect(capturedPrompt).toContain("Markeb market is fabricated")
    expect(capturedPrompt).not.toContain("RAW_EVAL_PROMPT_MUST_NOT_LEAK")
    // The directive framing that tells a small model to aim for 1-3 on real material.
    expect(capturedPrompt).toContain("aim for 1 to 3 proposals")
  })

  it("skip gate: a cycle with tool calls but NO step boundary is skipped (no turn), and logs the skip", async () => {
    // The observed session-start misfire shape: tool calls / setup, zero steps.
    await Effect.runPromise(appendToolEpisode(char, { ts: "t", tick: 1, stepId: null, tool: "bash", argsSummary: "{}", status: "completed", durationMs: 1 }))
    await Effect.runPromise(appendTransitionEpisode(char, { type: "tier", ts: "t", tick: 1, stepId: null, phase: "orient", prompt: "p", output: {} }))
    const errors: string[] = []
    const system: string[] = []
    const out = await Effect.runPromise(
      retrospect.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
        .pipe(Effect.provide(deps([], errors, system))) as Effect.Effect<{ proposals: number }, never, never>,
    )
    expect(out.proposals).toBe(0)
    expect(runTurnMock).not.toHaveBeenCalled()
    expect(system.some((m) => /retrospect_skipped: empty cycle/.test(m))).toBe(true)
  })

  it("skip gate: a cycle WITH a step boundary runs the turn (not skipped)", async () => {
    await Effect.runPromise(appendTransitionEpisode(char, {
      type: "step-start", ts: "t", tick: 1, stepId: "c2-s1-0", task: "begin work", goal: "g", skill: null, wmDeltas: null,
    }))
    runTurnMock.mockImplementation(() => Effect.succeed({ output: JSON.stringify({ proposals: [] }), timedOut: false, durationMs: 1 }))
    const errors: string[] = []
    const system: string[] = []
    const out = await Effect.runPromise(
      retrospect.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
        .pipe(Effect.provide(deps([], errors, system))) as Effect.Effect<{ proposals: number }, never, never>,
    )
    expect(out.proposals).toBe(0)
    expect(runTurnMock).toHaveBeenCalled()
    expect(system.some((m) => /retrospect_skipped/.test(m))).toBe(false)
  })
})
