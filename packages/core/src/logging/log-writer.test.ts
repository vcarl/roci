import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { FileSystem } from "@effect/platform"
import * as os from "node:os"
import * as path from "node:path"
import { CharacterLog, CharacterLogLive, logToConsole } from "./log-writer.js"
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
})
