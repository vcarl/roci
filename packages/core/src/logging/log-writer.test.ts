import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { FileSystem } from "@effect/platform"
import * as os from "node:os"
import * as path from "node:path"
import { CharacterLog, CharacterLogLive, logToConsole, logExchange, logError, logBehavior, logSessionEnd } from "./log-writer.js"
import { resetBehaviorDigest } from "./behavior-digest.js"
import { ProjectRoot } from "../services/ProjectRoot.js"

let tmp: string
let logSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  tmp = path.join(os.tmpdir(), `logtest-${process.hrtime.bigint()}`)
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => {
  logSpy.mockRestore()
  delete process.env.LOG_LEVEL
})

const run = (eff: Effect.Effect<unknown, unknown, CharacterLog>) => {
  const layer = CharacterLogLive.pipe(
    Layer.provide(Layer.mergeAll(NodeFileSystem.layer, Layer.succeed(ProjectRoot, tmp))),
  )
  return Effect.runPromise(eff.pipe(Effect.provide(layer)) as Effect.Effect<unknown, unknown, never>)
}

const readJsonl = (eff: Effect.Effect<unknown, unknown, CharacterLog>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* eff
      const fs = yield* FileSystem.FileSystem
      return yield* fs.readFileString(path.join(tmp, "players", "c", "logs", "events.jsonl"))
    }).pipe(
      Effect.provide(
        CharacterLogLive.pipe(Layer.provide(Layer.mergeAll(NodeFileSystem.layer, Layer.succeed(ProjectRoot, tmp)))),
      ),
      Effect.provide(NodeFileSystem.layer),
    ) as Effect.Effect<string, unknown, never>,
  )

describe("CharacterLog emit", () => {
  it("writes the resolved level into the jsonl line", async () => {
    const contents = await readJsonl(logToConsole("c", "cortex", "hello"))
    const line = JSON.parse(contents.trim().split("\n").pop() as string)
    expect(line.level).toBe("info")
  })

  it("suppresses below-threshold events from console but still writes jsonl", async () => {
    process.env.LOG_LEVEL = "info"
    const contents = await readJsonl(logToConsole("c", "body", "docker ...", "debug"))
    const line = JSON.parse(contents.trim().split("\n").pop() as string)
    expect(line.level).toBe("debug")
    // a debug event must not have produced a console line under the info threshold
    expect(logSpy.mock.calls.flat().some((a) => String(a).includes("docker ..."))).toBe(false)
  })

  it("renders at-or-above-threshold events to console", async () => {
    process.env.LOG_LEVEL = "info"
    await run(logToConsole("c", "cortex", "decided"))
    expect(logSpy.mock.calls.flat().some((a) => String(a).includes("decided"))).toBe(true)
  })

  it("logError emits a structured kind:error event resolved at error level", async () => {
    const contents = await readJsonl(logError("c", "hippocampus", "Consolidate failed: boom"))
    const line = JSON.parse(contents.trim().split("\n").pop() as string)
    expect(line.kind).toBe("error")
    expect(line.level).toBe("error")
    expect(line.message).toBe("Consolidate failed: boom")
    expect(line.subsystem).toBe("hippocampus")
  })

  it("logError renders to console even under a warn threshold (error outranks it)", async () => {
    process.env.LOG_LEVEL = "warn"
    await run(logError("c", "cortex", "diary turn failed"))
    expect(logSpy.mock.calls.flat().some((a) => String(a).includes("diary turn failed"))).toBe(true)
  })

  it("logExchange writes the full prompt and response to jsonl at debug", async () => {
    process.env.LOG_LEVEL = "info"
    const contents = await readJsonl(
      logExchange("c", "cortex", "orient", "P".repeat(50), "R".repeat(5000), { tier: "forebrain" }),
    )
    const line = JSON.parse(contents.trim().split("\n").pop() as string)
    expect(line.kind).toBe("exchange")
    expect(line.level).toBe("debug")
    expect(line.prompt.length).toBe(50)
    expect(line.response.length).toBe(5000) // full, untruncated
    expect(line.meta).toEqual({ tier: "forebrain" })
  })

  it("logBehavior writes a kind:behavior line carrying the structured behavior", async () => {
    resetBehaviorDigest("c")
    const contents = await readJsonl(
      logBehavior("c", "orchestrator", "main", { type: "phase", phase: "active", transition: "enter" }),
    )
    const line = JSON.parse(contents.trim().split("\n").pop() as string)
    expect(line.kind).toBe("behavior")
    expect(line.behavior.type).toBe("phase")
    expect(line.behavior.phase).toBe("active")
    expect(line.level).toBe("info")
  })

  it("logSessionEnd embeds a live digest snapshot inline", async () => {
    resetBehaviorDigest("c")
    const contents = await readJsonl(
      Effect.gen(function* () {
        yield* logBehavior("c", "orchestrator", "main", {
          type: "session_start",
          domain: "spacemolt",
          character: "c",
          gitSha: "abc1234",
          tickIntervalMs: 30000,
        })
        yield* logSessionEnd("c", "clean")
      }),
    )
    const last = JSON.parse(contents.trim().split("\n").pop() as string)
    expect(last.behavior.type).toBe("session_end")
    expect(last.behavior.reason).toBe("clean")
    expect(last.behavior.digest.counts.session_start).toBe(1)
    expect(last.behavior.digest.counts.session_end).toBe(1)
    expect(last.behavior.digest.terminalCause).toBe("session ended (clean)")
  })

  it("logSessionEnd is idempotent — a second call emits nothing", async () => {
    resetBehaviorDigest("c")
    const contents = await readJsonl(
      Effect.gen(function* () {
        yield* logSessionEnd("c", "clean")
        yield* logSessionEnd("c", "signal", "SIGTERM")
      }),
    )
    const endLines = contents.trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "behavior" && e.behavior.type === "session_end")
    expect(endLines).toHaveLength(1)
    expect(endLines[0].behavior.reason).toBe("clean")
  })
})
