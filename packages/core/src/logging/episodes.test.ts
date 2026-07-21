import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  ARGS_SUMMARY_MAX,
  EPISODE_RETAIN_CYCLES,
  EPOCH_SCAN_MAX_BYTES,
  TOOL_EPISODE_FILE,
  TRANSITION_EPISODE_FILE,
  summarizeArgs,
  setEpisodeLogRoot,
  setEpisodeTick,
  setEpisodeStep,
  episodeContext,
  resetEpisodeContext,
  beginEpisodeEpoch,
  currentEpisodeEpoch,
  mintStepId,
  appendToolEpisode,
  appendTransitionEpisode,
  sliceCurrentCycle,
  readCurrentCycleEpisodes,
  readCurrentStepToolEpisodes,
  retainLastCycles,
  finishEpisodeCycle,
  buildToolEpisodes,
  truncateCommand,
  COMMAND_MAX,
  type ToolEpisode,
  type WmTransitionEpisode,
} from "./episodes.js"
import type { InternalEvent } from "./stream-normalizer.js"

const toolRecord = (over: Partial<ToolEpisode> = {}): ToolEpisode => ({
  ts: "2026-07-02T00:00:00.000Z",
  tick: 3,
  stepId: "s3-0",
  tool: "bash",
  argsSummary: '{"command":"ls"}',
  status: "completed",
  durationMs: 42,
  ...over,
})

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "episodes-"))
  setEpisodeLogRoot(root)
  resetEpisodeContext("ada")
})
afterEach(() => {
  setEpisodeLogRoot(null)
  fs.rmSync(root, { recursive: true, force: true })
})

const logsPath = (file: string) => path.join(root, "players", "ada", "logs", file)
const readLines = (file: string): string[] =>
  fs.readFileSync(logsPath(file), "utf8").split("\n").filter((l) => l.trim().length > 0)

describe("summarizeArgs", () => {
  it("passes short args through as compact JSON", () => {
    expect(summarizeArgs({ command: "ls" })).toBe('{"command":"ls"}')
  })

  it("truncates to ARGS_SUMMARY_MAX chars plus a single ellipsis", () => {
    const s = summarizeArgs({ command: "x".repeat(1000) })
    expect(s.length).toBe(ARGS_SUMMARY_MAX + 1)
    expect(s.endsWith("…")).toBe(true)
    expect(ARGS_SUMMARY_MAX).toBe(200)
  })

  it("never throws on unserializable input", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(summarizeArgs(circular)).toBe("[unserializable args]")
  })
})

describe("episode context", () => {
  it("defaults to null tick and stepId", () => {
    expect(episodeContext("ada")).toEqual({ tick: null, stepId: null })
  })

  it("tracks tick and stepId independently and resets", () => {
    setEpisodeTick("ada", 7)
    setEpisodeStep("ada", "s7-1")
    expect(episodeContext("ada")).toEqual({ tick: 7, stepId: "s7-1" })
    setEpisodeStep("ada", null)
    expect(episodeContext("ada")).toEqual({ tick: 7, stepId: null })
    resetEpisodeContext("ada")
    expect(episodeContext("ada")).toEqual({ tick: null, stepId: null })
  })
})

describe("run epoch + stepId minting (uniqueness across runs AND process restarts)", () => {
  it("mintStepId composes c<epoch>-s<tick>-<step>, human-readable + citable", () => {
    expect(mintStepId("1", 5, 0)).toBe("c1-s5-0")
    expect(mintStepId("3", 42, 2)).toBe("c3-s42-2")
    expect(mintStepId("tabc123", 1, 0)).toBe("ctabc123-s1-0") // timestamp-fallback epoch
  })

  it("starts at 1 on a fresh character, increments in-process, clears the stale context", () => {
    // Simulate a prior run's dangling context.
    setEpisodeTick("ada", 99)
    setEpisodeStep("ada", "c1-s99-9")
    const e1 = beginEpisodeEpoch("ada")
    expect(e1).toBe("1")
    // Context cleared so no stale stepId bleeds into the new run.
    expect(episodeContext("ada")).toEqual({ tick: null, stepId: null })
    const e2 = beginEpisodeEpoch("ada")
    expect(e2).toBe("2")
    expect(mintStepId(e1, 1, 0)).not.toBe(mintStepId(e2, 1, 0))
  })

  it("a RESTARTED process continues past epochs already on disk — the cross-session collision fix", async () => {
    // Process A: epoch 1, mints c1-s1-0 and persists its step-start.
    const runA = beginEpisodeEpoch("ada")
    const idA = mintStepId(runA, 1, 0)
    expect(idA).toBe("c1-s1-0")
    await Effect.runPromise(
      appendTransitionEpisode("ada", {
        type: "step-start", ts: "t", tick: 1, stepId: idA,
        task: "a", goal: "g", skill: null, wmDeltas: null,
      }),
    )
    // Process restart: ALL in-memory module state for the character is gone,
    // but episodes-transition.jsonl persists (append-mode across restarts, and
    // rotation is by CYCLE count, so the retained window spans restarts).
    resetEpisodeContext("ada")
    // Process B, same tick/step as A — the exact shape of the observed 23x
    // "s1-0" cross-session collisions. It must NOT re-issue A's epoch.
    const runB = beginEpisodeEpoch("ada")
    const idB = mintStepId(runB, 1, 0)
    expect(idB).not.toBe(idA)
    expect(runB).toBe("2")
  })

  it("scans the tool stream too, so a step-start lost to a swallowed write still cannot collide", async () => {
    await Effect.runPromise(appendToolEpisode("ada", toolRecord({ stepId: "c7-s2-0" })))
    resetEpisodeContext("ada") // restart; transition file absent, tool file has c7
    expect(beginEpisodeEpoch("ada")).toBe("8")
  })

  it("legacy epoch-less ids (s1-0) are ignored by the scan and can never collide with new mints", async () => {
    await Effect.runPromise(
      appendTransitionEpisode("ada", {
        type: "step-start", ts: "t", tick: 1, stepId: "s1-0",
        task: "old", goal: "g", skill: null, wmDeltas: null,
      }),
    )
    resetEpisodeContext("ada")
    const e = beginEpisodeEpoch("ada")
    expect(e).toBe("1")
    expect(mintStepId(e, 1, 0)).toBe("c1-s1-0") // distinct from legacy "s1-0"
  })

  it("falls back to a TIMESTAMP epoch (never a low counter) when the scan errors", () => {
    // Make the logs path unreadable-as-a-directory: players/ada/logs is a FILE,
    // so opening logs/episodes-transition.jsonl fails ENOTDIR (not ENOENT).
    fs.mkdirSync(path.join(root, "players", "ada"), { recursive: true })
    fs.writeFileSync(path.join(root, "players", "ada", "logs"), "not a dir", "utf8")
    const e = beginEpisodeEpoch("ada")
    expect(e).toMatch(/^t[0-9a-z]+$/) // ms-since-epoch base36 — unique across restarts
    // A timestamp epoch can never collide with any numeric epoch's ids.
    expect(mintStepId(e, 1, 0)).not.toMatch(/^c\d+-/)
  })

  it("epoch state is per-character", () => {
    resetEpisodeContext("bob")
    beginEpisodeEpoch("ada")
    beginEpisodeEpoch("ada")
    expect(beginEpisodeEpoch("ada")).toBe("3")
    expect(beginEpisodeEpoch("bob")).toBe("1") // independent
    resetEpisodeContext("bob")
  })

  it("currentEpisodeEpoch exposes the issued epoch for record stamping; reset clears it", () => {
    expect(currentEpisodeEpoch("ada")).toBeNull()
    const e = beginEpisodeEpoch("ada")
    expect(currentEpisodeEpoch("ada")).toBe(e)
    resetEpisodeContext("ada")
    expect(currentEpisodeEpoch("ada")).toBeNull()
  })

  it("burying scenario: >512KB of null-stepId tier blobs after the last minted id — the epoch stamp on the blobs themselves rescues the scan", async () => {
    // Run A mints c1-s1-0 (step-start persisted, ZERO tool calls), then idles
    // hard: every idle orient/decide appends a multi-KB tier record with
    // stepId:null. The stepId evidence ends up buried beyond the scan window in
    // BOTH streams (the tool stream is empty) — the residual collision path.
    const e = beginEpisodeEpoch("ada")
    const idA = mintStepId(e, 1, 0)
    await Effect.runPromise(
      appendTransitionEpisode("ada", {
        type: "step-start", ts: "t", tick: 1, stepId: idA,
        task: "a", goal: "g", skill: null, wmDeltas: null,
      }),
    )
    const blob = "x".repeat(8 * 1024)
    for (let i = 0; i < 80; i++) {
      await Effect.runPromise(
        appendTransitionEpisode("ada", {
          type: "tier", ts: "t", tick: 2 + i, stepId: null, phase: "orient",
          orientKind: "plan", epoch: e, prompt: blob, output: {},
        }),
      )
    }
    // Sanity: the step-start really is beyond the tail window.
    expect(fs.statSync(logsPath(TRANSITION_EPISODE_FILE)).size).toBeGreaterThan(
      EPOCH_SCAN_MAX_BYTES + 8 * 1024,
    )
    resetEpisodeContext("ada") // restart
    expect(beginEpisodeEpoch("ada")).toBe("2") // NOT "1" — c1 must not re-mint
  })

  it("fails closed to a timestamp epoch when the only retained evidence is timestamp-epoch stamps", async () => {
    // A prior run degraded to a t-epoch (scan failure) and its stamped records
    // are the only evidence left in the window: numeric history may be buried
    // beneath them, so restarting the counter at 1 could silently collide —
    // fail closed to a fresh t-epoch instead.
    await Effect.runPromise(
      appendTransitionEpisode("ada", {
        type: "tier", ts: "t", tick: 1, stepId: null, phase: "orient",
        epoch: "tabc12", prompt: "p", output: {},
      }),
    )
    resetEpisodeContext("ada")
    expect(beginEpisodeEpoch("ada")).toMatch(/^t[0-9a-z]+$/)
  })

  it("mixed evidence: numeric epochs continue numerically even alongside timestamp stamps", async () => {
    await Effect.runPromise(
      appendTransitionEpisode("ada", {
        type: "tier", ts: "t", tick: 1, stepId: "ctabc12-s1-0", phase: "decide",
        epoch: "tabc12", prompt: "p", output: {},
      }),
    )
    await Effect.runPromise(
      appendTransitionEpisode("ada", {
        type: "tier", ts: "t", tick: 2, stepId: null, phase: "decide",
        epoch: "5", prompt: "p", output: {},
      }),
    )
    resetEpisodeContext("ada")
    expect(beginEpisodeEpoch("ada")).toBe("6")
  })
})

describe("append writers", () => {
  it("appends tool records as one JSON line each, creating the logs dir", async () => {
    await Effect.runPromise(appendToolEpisode("ada", toolRecord()))
    await Effect.runPromise(appendToolEpisode("ada", toolRecord({ tool: "read", durationMs: null })))
    const lines = readLines(TOOL_EPISODE_FILE)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toEqual(toolRecord())
    expect(JSON.parse(lines[1]).durationMs).toBeNull()
  })

  it("appends transition records to the transition stream", async () => {
    await Effect.runPromise(
      appendTransitionEpisode("ada", {
        type: "step-start",
        ts: "2026-07-02T00:00:00.000Z",
        tick: 3,
        stepId: "s3-0",
        task: "act",
        goal: "do the thing",
        skill: null,
        wmDeltas: null,
      }),
    )
    const [rec] = readLines(TRANSITION_EPISODE_FILE).map((l) => JSON.parse(l))
    expect(rec).toMatchObject({ type: "step-start", stepId: "s3-0", skill: null, wmDeltas: null })
  })

  it("is a no-op when no root is configured (tests and non-harness callers write nothing)", async () => {
    setEpisodeLogRoot(null)
    await Effect.runPromise(appendToolEpisode("ada", toolRecord()))
    expect(fs.existsSync(logsPath(TOOL_EPISODE_FILE))).toBe(false)
  })

  it("swallows write failures — never fails the effect (logging, not control flow)", async () => {
    // Make players/ a regular FILE so mkdir -p under it fails.
    fs.writeFileSync(path.join(root, "players"), "not a directory")
    await expect(Effect.runPromise(appendToolEpisode("ada", toolRecord()))).resolves.toBeUndefined()
  })
})

describe("retainLastCycles (pure rotation)", () => {
  const boundary = JSON.stringify({ type: "cycle-boundary", ts: "t" })
  const rec = (n: number) => JSON.stringify({ ts: `t${n}`, tool: "bash" })

  it("keeps everything when there are at most N completed cycles", () => {
    const lines = [rec(1), boundary, rec(2), boundary]
    expect(retainLastCycles(lines, 2)).toEqual(lines)
  })

  it("drops only whole cycles, keeping the last N with their boundaries", () => {
    const lines = [rec(1), boundary, rec(2), boundary, rec(3), boundary]
    expect(retainLastCycles(lines, 2)).toEqual([rec(2), boundary, rec(3), boundary])
  })

  it("keeps the in-progress tail after the last boundary", () => {
    const lines = [rec(1), boundary, rec(2), boundary, rec(3)]
    expect(retainLastCycles(lines, 1)).toEqual([rec(2), boundary, rec(3)])
  })

  it("preserves unparseable lines (they are never boundaries, never dropped alone)", () => {
    const lines = ["not json", boundary, rec(2), boundary]
    expect(retainLastCycles(lines, 1)).toEqual([rec(2), boundary])
  })
})

describe("finishEpisodeCycle", () => {
  it("appends a cycle-boundary to both streams and rotates whole cycles beyond EPISODE_RETAIN_CYCLES", async () => {
    for (let c = 1; c <= EPISODE_RETAIN_CYCLES + 2; c++) {
      await Effect.runPromise(appendToolEpisode("ada", toolRecord({ tick: c })))
      await Effect.runPromise(finishEpisodeCycle("ada"))
    }
    const records = readLines(TOOL_EPISODE_FILE).map((l) => JSON.parse(l))
    const ticks = records.filter((r) => r.tool === "bash").map((r) => r.tick)
    expect(ticks).toEqual([3, 4, 5, 6, 7]) // cycles 1-2 dropped whole
    expect(records.filter((r) => r.type === "cycle-boundary")).toHaveLength(EPISODE_RETAIN_CYCLES)
    // Transition stream got boundaries too (created even when otherwise empty).
    const transitions = readLines(TRANSITION_EPISODE_FILE).map((l) => JSON.parse(l))
    expect(transitions.every((r) => r.type === "cycle-boundary")).toBe(true)
  })

  it("never fails, even when the logs path is unwritable", async () => {
    fs.writeFileSync(path.join(root, "players"), "not a directory")
    await expect(Effect.runPromise(finishEpisodeCycle("ada"))).resolves.toBeUndefined()
  })
})

describe("wm transition records (Stage 2)", () => {
  it("appendTransitionEpisode accepts a type:\"wm\" record and rotation treats it as cycle content", async () => {
    const wmRecord: WmTransitionEpisode = {
      type: "wm",
      ts: "2026-07-02T00:00:00.000Z",
      tick: 3,
      stepId: null,
      deltas: [{ op: "add", id: "t1", text: "x", parent: null, by: "harness", ts: "2026-07-02T00:00:00.000Z" }],
    }
    await Effect.runPromise(appendTransitionEpisode("ada", wmRecord))
    const [rec] = readLines(TRANSITION_EPISODE_FILE).map((l) => JSON.parse(l))
    expect(rec).toMatchObject({ type: "wm", tick: 3 })
    expect(rec.deltas).toHaveLength(1)
    // Rotation: wm records are ordinary cycle content, dropped with their cycle.
    await Effect.runPromise(finishEpisodeCycle("ada"))
    for (let c = 0; c < EPISODE_RETAIN_CYCLES; c++) await Effect.runPromise(finishEpisodeCycle("ada"))
    const remaining = readLines(TRANSITION_EPISODE_FILE).map((l) => JSON.parse(l))
    expect(remaining.every((r) => r.type === "cycle-boundary")).toBe(true)
  })
})

describe("finishEpisodeCycle — per-file isolation (deferred Stage-1 fix)", () => {
  it("still writes the transition boundary when the tool stream is unwritable", async () => {
    // Make the tool stream path a DIRECTORY: appendFile → EISDIR for that stream only.
    fs.mkdirSync(logsPath(TOOL_EPISODE_FILE), { recursive: true })
    await expect(Effect.runPromise(finishEpisodeCycle("ada"))).resolves.toBeUndefined()
    const transitions = readLines(TRANSITION_EPISODE_FILE).map((l) => JSON.parse(l))
    expect(transitions.some((r) => r.type === "cycle-boundary")).toBe(true)
  })

  it("removes a stale orphaned .tmp left by a previously failed rotation", async () => {
    await Effect.runPromise(appendToolEpisode("ada", toolRecord()))
    fs.writeFileSync(`${logsPath(TOOL_EPISODE_FILE)}.tmp`, "orphan from a crashed rotation")
    await Effect.runPromise(finishEpisodeCycle("ada"))
    expect(fs.existsSync(`${logsPath(TOOL_EPISODE_FILE)}.tmp`)).toBe(false)
    // The real stream is untouched by the orphan: its record + boundary parse fine.
    const records = readLines(TOOL_EPISODE_FILE).map((l) => JSON.parse(l))
    expect(records.some((r) => r.tool === "bash")).toBe(true)
    expect(records.some((r) => r.type === "cycle-boundary")).toBe(true)
  })
})

describe("sliceCurrentCycle / readCurrentCycleEpisodes", () => {
  it("sliceCurrentCycle returns the tail past the last cycle-boundary", () => {
    const lines = [
      JSON.stringify({ type: "step-end", stepId: "a" }),
      JSON.stringify({ type: "cycle-boundary", ts: "t1" }),
      JSON.stringify({ type: "step-end", stepId: "b" }),
      JSON.stringify({ type: "step-end", stepId: "c" }),
    ]
    expect(sliceCurrentCycle(lines)).toEqual([lines[2], lines[3]])
  })
  it("sliceCurrentCycle returns all lines when there is no boundary", () => {
    const lines = [JSON.stringify({ type: "step-end", stepId: "a" })]
    expect(sliceCurrentCycle(lines)).toEqual(lines)
  })

  it("reads only the current (not-yet-closed) cycle from both streams", async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "episodes-cur-"))
    setEpisodeLogRoot(testRoot)
    try {
      // Prior cycle: one tool call + one step, then a boundary.
      await Effect.runPromise(appendToolEpisode("ada", {
        ts: "t", tick: 1, stepId: "old", tool: "bash", argsSummary: "{}", status: "completed", durationMs: 1,
      }))
      await Effect.runPromise(appendTransitionEpisode("ada", {
        type: "step-end", ts: "t", tick: 1, stepId: "old", task: "old", goal: "g",
        verdict: "succeeded", transition: "next_step", skill: null, wmDeltas: null,
      }))
      await Effect.runPromise(finishEpisodeCycle("ada")) // closes cycle 1

      // Current cycle: one new tool call + step-end.
      await Effect.runPromise(appendToolEpisode("ada", {
        ts: "t", tick: 2, stepId: "new", tool: "read", argsSummary: "{}", status: "error", durationMs: 1,
      }))
      await Effect.runPromise(appendTransitionEpisode("ada", {
        type: "step-end", ts: "t", tick: 2, stepId: "new", task: "new", goal: "g",
        verdict: "failed", transition: "next_step", skill: "securing-fuel", wmDeltas: null,
      }))

      const { tool, transition } = await Effect.runPromise(readCurrentCycleEpisodes("ada"))
      expect(tool.map((t) => t.stepId)).toEqual(["new"])
      expect(transition.filter((r) => r.type === "step-end").map((r) => (r as { stepId: string }).stepId)).toEqual(["new"])
    } finally {
      setEpisodeLogRoot(null)
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("returns empty arrays when the episode root is unset", async () => {
    setEpisodeLogRoot(null)
    expect(await Effect.runPromise(readCurrentCycleEpisodes("ghost"))).toEqual({ tool: [], transition: [] })
  })
})

// ── Mechanical trace enrichment (buildToolEpisodes + read helper) ────────────
describe("truncateCommand", () => {
  it("passes a short command through unchanged", () => {
    expect(truncateCommand("ls -la")).toBe("ls -la")
  })
  it("truncates at COMMAND_MAX and appends an ellipsis", () => {
    const long = "x".repeat(COMMAND_MAX + 80)
    const out = truncateCommand(long)
    expect(out).toBe(`${"x".repeat(COMMAND_MAX)}…`)
    expect(out.length).toBe(COMMAND_MAX + 1)
  })
  it("keeps a command exactly at the cap intact", () => {
    const exact = "y".repeat(COMMAND_MAX)
    expect(truncateCommand(exact)).toBe(exact)
  })
})

describe("buildToolEpisodes", () => {
  const ctx = { tick: 5, stepId: "c1-s5-0" }
  const now = () => "2026-07-21T00:00:00.000Z"

  it("captures description + command and joins the tool_result output size", () => {
    const internal: InternalEvent[] = [
      { type: "tool_use", id: "prt_1", name: "bash", input: { command: "spacemolt storage/view", description: "Check storage" }, status: "completed", durationMs: 7 },
      { type: "tool_result", toolUseId: "prt_1", text: "Storage at frontier_station\nItems (2):" },
    ]
    const [rec] = buildToolEpisodes(internal, ctx, now)
    expect(rec).toEqual({
      ts: "2026-07-21T00:00:00.000Z",
      tick: 5,
      stepId: "c1-s5-0",
      tool: "bash",
      argsSummary: '{"command":"spacemolt storage/view","description":"Check storage"}',
      status: "completed",
      durationMs: 7,
      description: "Check storage",
      command: "spacemolt storage/view",
      outputChars: "Storage at frontier_station\nItems (2):".length,
    })
  })

  it("truncates a long command to COMMAND_MAX with an ellipsis", () => {
    const command = `spacemolt ${"a".repeat(200)}`
    const [rec] = buildToolEpisodes(
      [{ type: "tool_use", id: "p", name: "bash", input: { command }, status: "completed" }],
      ctx,
      now,
    )
    expect(rec.command).toBe(`${command.slice(0, COMMAND_MAX)}…`)
  })

  it("falls back to a truncated argsSummary for a non-bash tool (no input.command)", () => {
    const [rec] = buildToolEpisodes(
      [{ type: "tool_use", id: "p", name: "read", input: { file: "x.ts" }, status: "completed" }],
      ctx,
      now,
    )
    expect(rec.description).toBeUndefined()
    expect(rec.command).toBe('{"file":"x.ts"}')
  })

  it("captures a numeric exit code and an error class name", () => {
    const [num] = buildToolEpisodes(
      [{ type: "tool_use", id: "p", name: "bash", input: { command: "false" }, status: "error", exitCode: 1 }],
      ctx,
      now,
    )
    expect(num.exitCode).toBe(1)
    const [named] = buildToolEpisodes(
      [{ type: "tool_use", id: "p", name: "bash", input: {}, status: "error", exitCode: "TimeoutError" }],
      ctx,
      now,
    )
    expect(named.exitCode).toBe("TimeoutError")
  })

  it("a terminal tool_use WITHOUT a matching tool_result carries no outputChars", () => {
    const [rec] = buildToolEpisodes(
      [{ type: "tool_use", id: "lonely", name: "bash", input: { command: "ls" }, status: "completed" }],
      ctx,
      now,
    )
    expect(rec.outputChars).toBeUndefined()
    expect(rec.durationMs).toBeNull()
  })

  it("a tool_result WITHOUT a prior tool_use yields no episode", () => {
    expect(buildToolEpisodes([{ type: "tool_result", toolUseId: "ghost", text: "orphan" }], ctx, now)).toEqual([])
  })

  it("skips non-terminal (running / status-less) tool calls", () => {
    const internal: InternalEvent[] = [
      { type: "tool_use", id: "a", name: "bash", input: {}, status: "running" },
      { type: "tool_use", id: "b", name: "bash", input: {} },
    ]
    expect(buildToolEpisodes(internal, ctx, now)).toEqual([])
  })
})

describe("readCurrentStepToolEpisodes", () => {
  it("returns only the requested step's tool records, chronologically", async () => {
    setEpisodeStep("ada", "c1-s1-0")
    await Effect.runPromise(appendToolEpisode("ada", toolRecord({ stepId: "c1-s1-0", command: "a" })))
    await Effect.runPromise(appendToolEpisode("ada", toolRecord({ stepId: "c1-s1-0", command: "b" })))
    await Effect.runPromise(appendToolEpisode("ada", toolRecord({ stepId: "c1-s2-0", command: "other" })))
    const step = await Effect.runPromise(readCurrentStepToolEpisodes("ada", "c1-s1-0"))
    expect(step.map((e) => e.command)).toEqual(["a", "b"])
  })

  it("degrades to an empty array when the root is unset", async () => {
    setEpisodeLogRoot(null)
    expect(await Effect.runPromise(readCurrentStepToolEpisodes("ghost", "s"))).toEqual([])
  })
})
