import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { CharacterConfig } from "../services/CharacterFs.js"
import type { ToolEpisode, TransitionEpisode } from "../logging/episodes.js"
import {
  MAX_PROPOSALS_PER_CYCLE,
  MAX_PENDING_PROPOSALS,
  aggregateEpisodes,
  renderAggregate,
  renderRawSample,
  renderTransitionDigest,
  TIER_DIGEST_MAX_RECORDS,
  WM_DIGEST_MAX_RECORDS,
  TRANSITION_EXCERPT_MAX,
  proposalKey,
  parseProposals,
  proposalsJsonlPath,
  readProposals,
  appendProposals,
  MACRO_EVERY_N,
  macroEveryN,
  readMacroCount,
  bumpMacroCount,
  macroStatePath,
  appendAdjudications,
  adjudicationsJsonlPath,
  removeProposals,
  parseAdjudicationDoc,
  type SkillProposal,
  type Adjudication,
} from "./growth-store.js"

const stepStart = (stepId: string, skill: string | null): TransitionEpisode => ({
  type: "step-start", ts: "t", tick: 1, stepId, task: "task " + stepId, goal: "g", skill, wmDeltas: null,
})
const stepEnd = (
  stepId: string, skill: string | null, verdict: "succeeded" | "partially_succeeded" | "failed",
): TransitionEpisode => ({
  type: "step-end", ts: "t", tick: 1, stepId, task: "task " + stepId, goal: "g",
  verdict, transition: "next_step", skill, wmDeltas: null,
})
const toolRec = (stepId: string | null, tool: string, status: string): ToolEpisode => ({
  ts: "t", tick: 1, stepId, tool, argsSummary: "{}", status, durationMs: 1,
})

describe("aggregateEpisodes", () => {
  it("tallies steps, per-skill verdicts, and joins tool calls/failures to skills via stepId", () => {
    const transition: TransitionEpisode[] = [
      stepStart("s1", "securing-fuel"), stepEnd("s1", "securing-fuel", "succeeded"),
      stepStart("s2", "securing-fuel"), stepEnd("s2", "securing-fuel", "failed"),
      stepStart("s3", null), stepEnd("s3", null, "succeeded"),
    ]
    const tool: ToolEpisode[] = [
      toolRec("s1", "bash", "completed"),
      toolRec("s2", "bash", "error"),
      toolRec("s2", "read", "error"),
      toolRec(null, "bash", "completed"), // untracked step → attributed to "(none)"
    ]
    const agg = aggregateEpisodes(tool, transition)
    expect(agg.totalSteps).toBe(3)
    expect(agg.totalToolCalls).toBe(4)
    expect(agg.totalToolFailures).toBe(2)
    const fuel = agg.perSkill.find((s) => s.skill === "securing-fuel")!
    expect(fuel.steps).toBe(2)
    expect(fuel.verdicts.succeeded).toBe(1)
    expect(fuel.verdicts.failed).toBe(1)
    expect(fuel.toolCalls).toBe(3)
    expect(fuel.toolFailures).toBe(2)
    const none = agg.perSkill.find((s) => s.skill === "(none)")!
    expect(none.steps).toBe(1)
    expect(none.toolCalls).toBe(1)
  })
})

describe("renderAggregate / renderRawSample — bounded, no raw prompt blobs", () => {
  it("renders compact per-skill lines and a step totals header", () => {
    const agg = aggregateEpisodes(
      [toolRec("s1", "bash", "error")],
      [stepStart("s1", "securing-fuel"), stepEnd("s1", "securing-fuel", "failed")],
    )
    const text = renderAggregate(agg)
    expect(text).toContain("1 steps")
    expect(text).toContain("securing-fuel")
    expect(text).toContain("1 failed")
  })
  it("raw sample is only the last N step-end lines, task-truncated, never full outputs", () => {
    const transition: TransitionEpisode[] = []
    for (let i = 0; i < 20; i++) transition.push(stepEnd(`s${i}`, "securing-fuel", "succeeded"))
    const sample = renderRawSample(transition, 5)
    const lines = sample.split("\n")
    expect(lines).toHaveLength(5) // capped to last 5
    expect(lines[0]).toContain("s15") // the last 5 are s15..s19
    expect(lines[4]).toContain("s19")
    expect(sample).toContain("verdict=succeeded")
  })
})

const tierRec = (
  stepId: string | null, phase: "orient" | "decide" | "evaluate" | "diary", output: unknown,
  extra: Partial<TransitionEpisode> = {},
): TransitionEpisode => ({
  type: "tier", ts: "t", tick: 1, stepId, phase, prompt: "RAW_PROMPT_BLOB", output, ...extra,
} as TransitionEpisode)
const wmRec = (stepId: string | null, deltas: unknown[]): TransitionEpisode => ({
  type: "wm", ts: "t", tick: 1, stepId, deltas,
})

describe("renderTransitionDigest — bounded tier + wm read path", () => {
  it("reads tier + wm records (which the aggregate/raw-sample projections skip)", () => {
    const transition: TransitionEpisode[] = [
      tierRec("c1-s1-0", "evaluate", { judgment: "failed", reasoning: "SERVER_BUG" }),
      wmRec("c1-s1-0", [{ verb: "add", id: "t1", text: "NOTE" }]),
    ]
    const out = renderTransitionDigest(transition)
    expect(out).toContain("SERVER_BUG")
    expect(out).toContain("[c1-s1-0]")
    expect(out).toContain("evaluate")
    expect(out).toContain("1 delta(s)")
    expect(out).toContain("NOTE")
  })

  it("NEVER leaks the raw rendered prompt blob (parsed output only)", () => {
    const out = renderTransitionDigest([tierRec("c1-s1-0", "decide", { decision: "plan" })])
    expect(out).not.toContain("RAW_PROMPT_BLOB")
    expect(out).toContain("decision")
  })

  it("includes the orient discriminator (plan vs steer)", () => {
    const out = renderTransitionDigest([
      tierRec("c1-s1-0", "orient", { headline: "H1" }, { orientKind: "plan" }),
      tierRec("c1-s2-0", "orient", { headline: "H2" }, { orientKind: "steer" }),
    ])
    expect(out).toContain("orient/plan")
    expect(out).toContain("orient/steer")
  })

  it("count-caps each type and orders newest-first", () => {
    const transition: TransitionEpisode[] = []
    for (let i = 0; i < TIER_DIGEST_MAX_RECORDS + 5; i++) transition.push(tierRec(`c1-s${i}-0`, "decide", { i }))
    for (let i = 0; i < WM_DIGEST_MAX_RECORDS + 5; i++) transition.push(wmRec(`c1-s${i}-0`, [{ i }]))
    const out = renderTransitionDigest(transition)
    const tierLines = out.split("\n").filter((l) => l.startsWith("- ") && l.includes("decide"))
    const wmLines = out.split("\n").filter((l) => l.startsWith("- ") && l.includes("delta(s)"))
    expect(tierLines).toHaveLength(TIER_DIGEST_MAX_RECORDS)
    expect(wmLines).toHaveLength(WM_DIGEST_MAX_RECORDS)
    // Newest-first: the highest index leads.
    expect(tierLines[0]).toContain(`c1-s${TIER_DIGEST_MAX_RECORDS + 4}-0`)
  })

  it("char-caps each excerpt with a trailing ellipsis", () => {
    const out = renderTransitionDigest([tierRec("c1-s1-0", "evaluate", { reasoning: "x".repeat(2000) })])
    const line = out.split("\n").find((l) => l.startsWith("- "))!
    expect(line).toContain("…")
    // The excerpt itself is bounded (line has some fixed prefix + capped excerpt).
    expect(line.length).toBeLessThan(TRANSITION_EXCERPT_MAX + 120)
  })

  it("renders empty-section placeholders when a type has no records", () => {
    const out = renderTransitionDigest([])
    expect(out).toContain("no tier transitions recorded")
    expect(out).toContain("no working-memory mutations recorded")
  })
})

describe("parseProposals — evidence required, capped, tolerant", () => {
  const now = "2026-07-03T00:00:00.000Z"
  it("keeps a well-formed proposal with evidence and assigns id/ts/status", () => {
    const out = parseProposals(
      JSON.stringify({
        proposals: [
          { action: "revise", skill: "securing-fuel", summary: "Top up earlier", body: "new body", evidence: "steps s2 failed; 2 tool failures" },
        ],
      }),
      now,
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      action: "revise", skill: "securing-fuel", summary: "Top up earlier", body: "new body",
      evidence: "steps s2 failed; 2 tool failures", status: "pending", ts: now,
    })
    expect(out[0].id).toBe(proposalKey("revise", "securing-fuel", "Top up earlier"))
  })
  it("REJECTS a proposal with no evidence (spec §4)", () => {
    const out = parseProposals(
      JSON.stringify({ proposals: [{ action: "create", skill: "x", summary: "s", evidence: "  " }] }),
      now,
    )
    expect(out).toEqual([])
  })
  it("REJECTS proposals missing action/skill/summary, keeps the valid ones", () => {
    const out = parseProposals(
      JSON.stringify({
        proposals: [
          { action: "bogus", skill: "a", summary: "s", evidence: "e" },
          { action: "retire", skill: "", summary: "s", evidence: "e" },
          { action: "retire", skill: "stale", summary: "", evidence: "e" },
          { action: "retire", skill: "stale", summary: "unused all cycle", evidence: "0 steps worn" },
        ],
      }),
      now,
    )
    expect(out.map((p) => p.action)).toEqual(["retire"])
    expect(out[0].body).toBeUndefined() // retire carries no body
  })
  it("tolerates a ```json fence and a bare array, and caps to MAX_PROPOSALS_PER_CYCLE", () => {
    const many = Array.from({ length: MAX_PROPOSALS_PER_CYCLE + 3 }, (_, i) => ({
      action: "create", skill: `s${i}`, summary: `sum ${i}`, evidence: `ev ${i}`,
    }))
    const fenced = "```json\n" + JSON.stringify(many) + "\n```"
    expect(parseProposals(fenced, now)).toHaveLength(MAX_PROPOSALS_PER_CYCLE)
  })
  it("returns [] on garbage (never throws)", () => {
    expect(parseProposals("not json at all", now)).toEqual([])
    expect(parseProposals("", now)).toEqual([])
  })
  it("recovers a fenced proposal whose body contains a nested triple-backtick block", () => {
    // A naive fence-regex (```(?:json)?\s*([\s\S]*?)```) matches the FIRST closing
    // fence it finds — which is the nested ```bash``` block inside the proposal's
    // `body`, not the outer fence. That truncates the slice mid-JSON and JSON.parse
    // throws, silently dropping every proposal in the cycle.
    const inner = JSON.stringify({
      proposals: [
        {
          action: "create",
          skill: "retry-with-backoff",
          summary: "Capture the retry pattern",
          body: "Use this pattern:\n```bash\ncurl --retry 3 url\n```\nThen check exit code.",
          evidence: "steps s1,s2 failed with transient errors; retried manually",
        },
      ],
    })
    const fenced = "```json\n" + inner + "\n```"
    const out = parseProposals(fenced, now)
    expect(out).toHaveLength(1)
    expect(out[0].skill).toBe("retry-with-backoff")
    expect(out[0].body).toContain("```bash")
  })
  it("recovers a bare (unfenced) proposal whose body contains a triple-backtick block", () => {
    const inner = JSON.stringify({
      proposals: [
        {
          action: "revise",
          skill: "securing-fuel",
          summary: "Note the check command",
          body: "Run:\n```sh\ncheck-fuel --verbose\n```",
          evidence: "step s3 succeeded after manual check",
        },
      ],
    })
    const out = parseProposals(inner, now)
    expect(out).toHaveLength(1)
    expect(out[0].skill).toBe("securing-fuel")
    expect(out[0].body).toContain("```sh")
  })
  it("still returns [] for prose-only output with no JSON at all", () => {
    expect(parseProposals("I looked things over and nothing needs to change.", now)).toEqual([])
  })
})

describe("readProposals / appendProposals — atomic, dedup, total cap, never-fail", () => {
  let root: string
  let char: CharacterConfig
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "growth-"))
    char = { name: "ada", dir: path.join(root, "players", "ada", "me") }
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const mkProps = (n: number): SkillProposal[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `id-${i}`, ts: "t", action: "create" as const, skill: `s${i}`,
      summary: `sum ${i}`, evidence: `ev ${i}`, status: "pending" as const,
    }))

  it("missing file → readProposals returns []", async () => {
    expect(await Effect.runPromise(readProposals(char))).toEqual([])
  })
  it("appends, persists atomically, and reads back", async () => {
    const n = await Effect.runPromise(appendProposals(char, mkProps(2)))
    expect(n).toBe(2)
    expect(fs.existsSync(proposalsJsonlPath(char))).toBe(true)
    const read = await Effect.runPromise(readProposals(char))
    expect(read.map((p) => p.id)).toEqual(["id-0", "id-1"])
  })
  it("dedups exact-duplicate ids against the existing pending set", async () => {
    await Effect.runPromise(appendProposals(char, mkProps(2)))
    const appended = await Effect.runPromise(appendProposals(char, mkProps(3))) // id-0,id-1 dup; id-2 new
    expect(appended).toBe(1)
    expect((await Effect.runPromise(readProposals(char))).map((p) => p.id)).toEqual(["id-0", "id-1", "id-2"])
  })
  it("enforces MAX_PENDING_PROPOSALS by keeping the newest", async () => {
    const first = Array.from({ length: MAX_PENDING_PROPOSALS }, (_, i) => ({ ...mkProps(1)[0], id: `a-${i}` }))
    await Effect.runPromise(appendProposals(char, first))
    await Effect.runPromise(appendProposals(char, [{ ...mkProps(1)[0], id: "z-new" }]))
    const read = await Effect.runPromise(readProposals(char))
    expect(read).toHaveLength(MAX_PENDING_PROPOSALS)
    expect(read[read.length - 1].id).toBe("z-new") // newest kept
    expect(read.some((p) => p.id === "a-0")).toBe(false) // oldest dropped
  })
  it("dedups two identical-id proposals within the SAME batch (not just against disk)", async () => {
    const dup = mkProps(1)[0]
    const appended = await Effect.runPromise(appendProposals(char, [dup, { ...dup }]))
    expect(appended).toBe(1)
    const read = await Effect.runPromise(readProposals(char))
    expect(read.map((p) => p.id)).toEqual([dup.id])
  })
  it("never throws when the growth dir path is unwritable", async () => {
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, "players"), "not a directory") // mkdir -p will fail
    await expect(Effect.runPromise(appendProposals(char, mkProps(1)))).resolves.toBe(0)
  })
})

describe("macro counter — persisted, atomic, never-fail", () => {
  let root: string
  let char: CharacterConfig
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "macro-"))
    char = { name: "ada", dir: path.join(root, "players", "ada", "me") }
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("MACRO_EVERY_N default is 4; macroEveryN honors ROCI_MACRO_EVERY_N and floors invalid at the default", () => {
    expect(MACRO_EVERY_N).toBe(4)
    const prev = process.env.ROCI_MACRO_EVERY_N
    try {
      process.env.ROCI_MACRO_EVERY_N = "2"
      expect(macroEveryN()).toBe(2)
      process.env.ROCI_MACRO_EVERY_N = "0"
      expect(macroEveryN()).toBe(MACRO_EVERY_N) // <1 → default
      process.env.ROCI_MACRO_EVERY_N = "nonsense"
      expect(macroEveryN()).toBe(MACRO_EVERY_N)
    } finally {
      if (prev === undefined) delete process.env.ROCI_MACRO_EVERY_N
      else process.env.ROCI_MACRO_EVERY_N = prev
    }
  })

  it("missing state → 0; bump persists (advanced) and increments across reads", async () => {
    expect(await Effect.runPromise(readMacroCount(char))).toBe(0)
    expect(await Effect.runPromise(bumpMacroCount(char))).toEqual({ count: 1, advanced: true })
    expect(await Effect.runPromise(bumpMacroCount(char))).toEqual({ count: 2, advanced: true })
    expect(await Effect.runPromise(readMacroCount(char))).toBe(2)
  })

  it("frozen-at-a-multiple: state reads at a multiple of N but the write fails → advanced:false with the STALE count (follow-up 2)", async () => {
    // Seed a persisted count at a MULTIPLE of N (4), then make the growth dir
    // read-only so the existing file still READS but the atomic tmp write FAILS.
    // The bump must report advanced:false with the stale 4 so the macro gate
    // fails closed instead of re-firing the reasoning turn every cycle.
    const dir = path.dirname(macroStatePath(char))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(macroStatePath(char), JSON.stringify({ count: 4 }))
    fs.chmodSync(dir, 0o555) // read+execute, no write
    try {
      await expect(Effect.runPromise(bumpMacroCount(char))).resolves.toEqual({ count: 4, advanced: false })
    } finally {
      fs.chmodSync(dir, 0o755) // restore so afterEach rm can clean up
    }
  })

  it("bump on a fresh unwritable dir reports advanced:false with count 0 (unavailable sentinel)", async () => {
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, "players"), "not a directory")
    await expect(Effect.runPromise(bumpMacroCount(char))).resolves.toEqual({ count: 0, advanced: false })
  })

  it("bump on an unwritable growth dir warns that macro will not fire this cycle (fail-closed sentinel)", async () => {
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, "players"), "not a directory")
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      await Effect.runPromise(bumpMacroCount(char))
      expect(spy).toHaveBeenCalledWith(expect.stringMatching(/macro will not fire this cycle/i))
    } finally {
      spy.mockRestore()
    }
  })
})

describe("appendAdjudications / removeProposals", () => {
  let root: string
  let char: CharacterConfig
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "adj-"))
    char = { name: "ada", dir: path.join(root, "players", "ada", "me") }
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const adj = (id: string, decision: "accepted" | "rejected"): Adjudication => ({
    id, ts: "t", cycle: 4, action: "revise", skill: "securing-fuel", decision, reason: "r",
  })

  it("appends adjudications as append-only jsonl and never throws", async () => {
    expect(await Effect.runPromise(appendAdjudications(char, [adj("a", "accepted"), adj("b", "rejected")]))).toBe(2)
    expect(await Effect.runPromise(appendAdjudications(char, [adj("c", "rejected")]))).toBe(1)
    const lines = fs.readFileSync(adjudicationsJsonlPath(char), "utf8").trim().split("\n")
    expect(lines).toHaveLength(3) // append-only: all three retained
    expect(JSON.parse(lines[2]).id).toBe("c")
  })

  it("removeProposals drains only the named ids from the pending queue", async () => {
    await Effect.runPromise(appendProposals(char, [
      { id: "id-0", ts: "t", action: "create", skill: "s0", summary: "s0", evidence: "e", status: "pending" },
      { id: "id-1", ts: "t", action: "create", skill: "s1", summary: "s1", evidence: "e", status: "pending" },
      { id: "id-2", ts: "t", action: "create", skill: "s2", summary: "s2", evidence: "e", status: "pending" },
    ]))
    const removed = await Effect.runPromise(removeProposals(char, ["id-0", "id-2", "unknown"]))
    expect(removed).toBe(2)
    expect((await Effect.runPromise(readProposals(char))).map((p) => p.id)).toEqual(["id-1"])
  })
})

describe("parseAdjudicationDoc — tolerant", () => {
  it("extracts decisions (with skill contents), synthesis, and diaryNote", () => {
    const doc = parseAdjudicationDoc(JSON.stringify({
      adjudications: [
        { id: "revise:securing-fuel:top up earlier", decision: "accept", reason: "clear win",
          skill: { name: "securing-fuel", description: "d", when_to_use: "w", body: "new body" } },
        { id: "create:x:junk", decision: "reject", reason: "no signal" },
      ],
      synthesis: "I am the ship that tops up early.",
      diaryNote: "Something reached into me while I rested.",
    }))
    expect(doc.decisions).toHaveLength(2)
    expect(doc.decisions[0]).toMatchObject({ decision: "accept", reason: "clear win" })
    expect(doc.decisions[0].skill).toMatchObject({ name: "securing-fuel", whenToUse: "w", body: "new body" })
    expect(doc.decisions[1]).toMatchObject({ decision: "reject", reason: "no signal", skill: undefined })
    expect(doc.synthesis).toContain("tops up early")
    expect(doc.diaryNote).toContain("reached into me")
  })

  it("tolerates a ```json fence and prose framing; missing fields → empty/null", () => {
    const doc = parseAdjudicationDoc("Here is my judgment:\n```json\n" + JSON.stringify({ adjudications: [] }) + "\n```")
    expect(doc.decisions).toEqual([])
    expect(doc.synthesis).toBeNull()
    expect(doc.diaryNote).toBeNull()
  })

  it("returns an empty doc on garbage (never throws)", () => {
    expect(parseAdjudicationDoc("not json")).toEqual({ decisions: [], synthesis: null, diaryNote: null })
  })
})

describe("firstBalancedBracket / extractProposalsArray — wrong-anchor hardening (Stage-4 review probes)", () => {
  const now = "2026-07-03T00:00:00.000Z"
  it("probe-5: prose containing an earlier bare '[' does not swallow the real proposals object", () => {
    const text =
      "Options I weighed [fuel, nav, comms] before deciding. My proposals:\n" +
      JSON.stringify({ proposals: [{ action: "revise", skill: "securing-fuel", summary: "top up earlier", evidence: "s1 failed" }] })
    const out = parseProposals(text, now)
    expect(out.map((p) => p.skill)).toEqual(["securing-fuel"])
  })
  it("probe-6: a non-JSON '{' block before the real object is skipped, recovering the later valid object", () => {
    const text =
      "note {this is prose, not json} then the real one: " +
      JSON.stringify({ proposals: [{ action: "create", skill: "docking-drill", summary: "practice docking", evidence: "s3 failed" }] })
    const out = parseProposals(text, now)
    expect(out.map((p) => p.skill)).toEqual(["docking-drill"])
  })
})
