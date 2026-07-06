import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { CommandExecutor } from "@effect/platform"
import { mkdtempSync, existsSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import nodePath from "node:path"
import { ConsciousThought, ConsciousThoughtTest, ConsciousThoughtLive } from "./conscious-thought.js"
import { FRONTIER_CLI_PATH } from "./frontier-cli.js"
import { CharacterLog } from "../../../logging/log-writer.js"
import { OAuthToken } from "../../../services/OAuthToken.js"
import { Docker } from "../../../services/Docker.js"
import { DEFAULT_CORTEX_MODELS } from "../../../model/handles.js"
import * as core from "../../../index.js"
import type { TurnResult } from "../../transport/types.js"

// Minimal stubs — ConsciousThoughtTest never calls the real transport.
const StubCommandExecutor = Layer.succeed(
  CommandExecutor.CommandExecutor,
  { start: () => { throw new Error("stub CommandExecutor: not implemented") } } as unknown as CommandExecutor.CommandExecutor,
)
const StubCharacterLog = Layer.succeed(
  CharacterLog,
  CharacterLog.of({ emit: () => Effect.void }),
)
const StubOAuthToken = Layer.succeed(
  OAuthToken,
  OAuthToken.of({
    getToken: Effect.succeed({ token: "stub", version: 0 }),
    validateInContainer: () => Effect.succeed(true),
  }),
)
const StubDocker = Layer.succeed(
  Docker,
  Docker.of({ exec: () => Effect.succeed("") } as unknown as typeof Docker.Service),
)
const testDeps = Layer.mergeAll(StubCommandExecutor, StubCharacterLog, StubOAuthToken, StubDocker)

const cannedResult: TurnResult = { output: "step complete", timedOut: false, durationMs: 100 }

describe("ConsciousThought service contract", () => {
  it("turn returns the canned result from ConsciousThoughtTest", async () => {
    const layer = Layer.merge(
      ConsciousThoughtTest(
        () => ({ result: cannedResult, sessionId: "ses_001" }),
        (_directive) => {},
      ),
      testDeps,
    )
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const ct = yield* ConsciousThought
          return yield* ct.turn({
            containerId: "c1",
            playerName: "ada",
            char: { name: "ada", dir: "/work/players/ada/me" },
            prompt: "do the task",
            timeoutMs: 60_000,
            modelLabel: "local/mlx-community/Qwen3.5-122B-A10B-4bit",
          })
        }),
        layer,
      ),
    )
    expect(result.sessionId).toBe("ses_001")
    expect(result.result.output).toBe("step complete")
  })

  it("ConsciousThoughtTest captures steer directives via onSteer", async () => {
    const captured: string[] = []
    const layer = Layer.merge(
      ConsciousThoughtTest(
        () => ({ result: cannedResult, sessionId: "ses_002" }),
        (d) => captured.push(d),
      ),
      testDeps,
    )
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const ct = yield* ConsciousThought
          // Simulate a steer turn: the directive text is the prompt on a resume call
          return yield* ct.turn({
            containerId: "c1",
            playerName: "ada",
            char: { name: "ada", dir: "/work/players/ada/me" },
            prompt: "steer: focus on the login flow",
            timeoutMs: 60_000,
            modelLabel: "local/mlx-community/Qwen3.5-122B-A10B-4bit",
          }, { sessionId: "ses_002" })
        }),
        layer,
      ),
    )
    expect(captured).toEqual(["steer: focus on the login flow"])
  })

  it("ConsciousThoughtTest returns a canned error-shaped result without throwing", async () => {
    const errorLayer = Layer.merge(
      ConsciousThoughtTest(
        () => ({ result: { output: "auth error", timedOut: false, durationMs: 0 }, sessionId: "error-sentinel" }),
      ),
      testDeps,
    )
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const ct = yield* ConsciousThought
          return yield* ct.turn({
            containerId: "c1",
            playerName: "ada",
            char: { name: "ada", dir: "/work/players/ada/me" },
            prompt: "do it",
            timeoutMs: 1000,
            modelLabel: "local/mlx-community/Qwen3.5-122B-A10B-4bit",
          })
        }),
        errorLayer,
      ),
    )
    expect(result.result.output).toBe("auth error")
    expect(result.sessionId).toBe("error-sentinel")
  })

  it("carries the handle-derived modelLabel through the turn config", async () => {
    const label = `local/${DEFAULT_CORTEX_MODELS.conscious.model}`
    let seenLabel: string | undefined
    const layer = Layer.merge(
      ConsciousThoughtTest((config) => {
        seenLabel = config.modelLabel
        return { result: cannedResult, sessionId: "ses_004" }
      }),
      testDeps,
    )
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const ct = yield* ConsciousThought
          return yield* ct.turn({
            containerId: "c1",
            playerName: "ada",
            char: { name: "ada", dir: "/work/players/ada/me" },
            prompt: "do the task",
            timeoutMs: 60_000,
            modelLabel: label,
          })
        }),
        layer,
      ),
    )
    expect(seenLabel).toBe(label)
    expect(seenLabel).toBe("local/mlx-community/gemma-4-31b-it-8bit")
  })

  it("provision is a no-op in ConsciousThoughtTest (does not throw)", async () => {
    const layer = Layer.merge(
      ConsciousThoughtTest(() => ({ result: cannedResult, sessionId: "ses_003" })),
      testDeps,
    )
    await expect(
      Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const ct = yield* ConsciousThought
            yield* ct.provision({
              containerId: "c1",
              char: { name: "ada", dir: "/work/players/ada/me" },
              handle: { tier: "conscious", provider: "mlx", baseUrl: "http://127.0.0.1:8083/v1", model: "qwen3" },
              systemPrompt: "you are ada",
              frontierModel: "sonnet",
              frontierTimeoutMs: 60_000,
            })
          }),
          layer,
        ),
      ),
    ).resolves.not.toThrow()
  })
})

describe("index re-exports ConsciousThought", () => {
  it("exports ConsciousThought tag and ConsciousThoughtLive layer", () => {
    expect(core.ConsciousThought).toBeDefined()
    expect(core.ConsciousThoughtLive).toBeDefined()
  })
})

describe("ConsciousThought.provision writes the frontier CLI", () => {
  const provisionOpts = (tempDir: string) => ({
    containerId: "cabc",
    char: { name: "ada", dir: nodePath.join(tempDir, "me") },
    handle: DEFAULT_CORTEX_MODELS.conscious,
    systemPrompt: "You are Ada.",
    frontierModel: "sonnet" as const,
    frontierTimeoutMs: 600000,
  })

  it("execs a docker command writing the frontier CLI path", async () => {
    const calls: string[][] = []
    const StubDockerCapturing = Layer.succeed(
      Docker,
      Docker.of({
        exec: (_id: string, command: string[]) => {
          calls.push(command)
          return Effect.succeed("")
        },
      } as unknown as typeof Docker.Service),
    )
    const tempDir = mkdtempSync(nodePath.join(tmpdir(), "roci-test-"))
    const program = Effect.gen(function* () {
      const ct = yield* ConsciousThought
      yield* ct.provision(provisionOpts(tempDir))
    })
    await Effect.runPromise(
      Effect.provide(program, Layer.mergeAll(ConsciousThoughtLive, StubDockerCapturing, StubCharacterLog)),
    )
    const joined = calls.flat().join(" ")
    expect(joined).toContain(FRONTIER_CLI_PATH)
  })

  // NOTE: the in-container `memory` CLI is no longer provisioned by `provision`
  // (it must not be hot-loaded during the active loop). It is now provisioned
  // eagerly at container startup in apps/roci/src/orchestrator.ts, so the former
  // "execs the memory CLI AS ROOT" / "logs a structured error on memory failure"
  // cases moved out of conscious-thought's responsibility and were removed here.

  it("provisions the working-memory injection config (opencode.json instructions → me/WM.md)", async () => {
    const StubDockerOk = Layer.succeed(
      Docker,
      Docker.of({ exec: () => Effect.succeed("") } as unknown as typeof Docker.Service),
    )
    const tempDir = mkdtempSync(nodePath.join(tmpdir(), "roci-wm-provision-"))
    const charDir = nodePath.join(tempDir, "players", "ada", "me")
    const program = Effect.gen(function* () {
      const ct = yield* ConsciousThought
      yield* ct.provision({ ...provisionOpts(tempDir), char: { name: "ada", dir: charDir } })
    })
    await Effect.runPromise(
      Effect.provide(program, Layer.mergeAll(ConsciousThoughtLive, StubDockerOk, StubCharacterLog)),
    )
    // Project-local opencode config: instructions → me/WM.md.
    const config = JSON.parse(
      readFileSync(nodePath.join(tempDir, "players", "ada", "opencode.json"), "utf8"),
    )
    expect(config.instructions).toEqual(["me/WM.md"])
    // NOTE: the wm FILES themselves (WM.md + wm.json) are no longer seeded by
    // `provision` — that host-side seeding (ensureWmFiles) moved to container
    // startup in apps/roci/src/orchestrator.ts, so this cortex executor holds no
    // wm (limbic) host-code dependency. provision only writes the instructions
    // config here; the file seed is asserted by the wm layer's tests + the orchestrator.
    expect(existsSync(nodePath.join(charDir, "WM.md"))).toBe(false)
    expect(existsSync(nodePath.join(charDir, "wm.json"))).toBe(false)
  })

  it("seeds the two starter skills (editing-skills, learning) idempotently", async () => {
    const StubDockerOk = Layer.succeed(
      Docker,
      Docker.of({ exec: () => Effect.succeed("") } as unknown as typeof Docker.Service),
    )
    const tempDir = mkdtempSync(nodePath.join(tmpdir(), "roci-skill-provision-"))
    const charDir = nodePath.join(tempDir, "players", "ada", "me")
    const provision = () =>
      Effect.provide(
        Effect.flatMap(ConsciousThought, (ct) =>
          ct.provision({ ...provisionOpts(tempDir), char: { name: "ada", dir: charDir } }),
        ),
        Layer.mergeAll(ConsciousThoughtLive, StubDockerOk, StubCharacterLog),
      )
    await Effect.runPromise(provision())
    const skillsDir = nodePath.join(charDir, "skills")
    expect(readdirSync(skillsDir).sort()).toEqual(["editing-skills.md", "learning.md"])
    expect(readFileSync(nodePath.join(skillsDir, "editing-skills.md"), "utf8")).toContain("name: editing-skills")

    // Idempotent: a re-provision leaves an agent-revised skill untouched.
    require("node:fs").writeFileSync(nodePath.join(skillsDir, "learning.md"), "REVISED")
    await Effect.runPromise(provision())
    expect(readFileSync(nodePath.join(skillsDir, "learning.md"), "utf8")).toBe("REVISED")
  })
})
