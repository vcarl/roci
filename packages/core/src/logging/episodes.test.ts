import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  ARGS_SUMMARY_MAX,
  TOOL_EPISODE_FILE,
  TRANSITION_EPISODE_FILE,
  summarizeArgs,
  setEpisodeLogRoot,
  setEpisodeTick,
  setEpisodeStep,
  episodeContext,
  resetEpisodeContext,
  appendToolEpisode,
  appendTransitionEpisode,
  type ToolEpisode,
} from "./episodes.js"

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
