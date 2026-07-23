import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { FileSystem } from "@effect/platform"
import * as os from "node:os"
import * as path from "node:path"
import { CharacterLogLive } from "../logging/log-writer.js"
import { ProjectRoot } from "../services/ProjectRoot.js"
import { runPhases } from "./phase-runner.js"
import type { PhaseContext, PhaseRegistry, PhaseResult } from "./phase.js"

let tmp: string
beforeEach(() => {
  tmp = path.join(os.tmpdir(), `phasetest-${process.hrtime.bigint()}`)
  vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe("runPhases — phase behaviors", () => {
  it("emits phase enter then exit behaviors around a phase", async () => {
    const ctx = { char: { name: "p", root: "" }, connection: undefined, phaseData: undefined } as unknown as PhaseContext<unknown, unknown>
    const registry: PhaseRegistry<unknown, unknown, never> = {
      initialPhase: "only",
      getPhase: (name: string) =>
        name === "only"
          ? { name: "only", run: () => Effect.succeed({ _tag: "Shutdown" } as PhaseResult<unknown, unknown>) }
          : undefined,
    } as unknown as PhaseRegistry<unknown, unknown, never>

    const layer = CharacterLogLive.pipe(
      Layer.provide(Layer.mergeAll(NodeFileSystem.layer, Layer.succeed(ProjectRoot, tmp))),
    )
    const contents = await Effect.runPromise(
      Effect.gen(function* () {
        yield* runPhases(ctx, registry)
        const fs = yield* FileSystem.FileSystem
        return yield* fs.readFileString(path.join(tmp, "players", "p", "logs", "events.jsonl"))
      }).pipe(
        Effect.provide(layer),
        Effect.provide(NodeFileSystem.layer),
      ) as Effect.Effect<string, unknown, never>,
    )
    const behaviors = contents.trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "behavior" && e.behavior.type === "phase")
    expect(behaviors.map((e) => e.behavior.transition)).toEqual(["enter", "exit"])
    expect(behaviors[0].behavior.phase).toBe("only")
  })
})
