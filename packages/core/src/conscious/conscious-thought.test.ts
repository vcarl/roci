import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { CommandExecutor } from "@effect/platform"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import nodePath from "node:path"
import { ConsciousThought, ConsciousThoughtTest, ConsciousThoughtLive } from "./conscious-thought.js"
import { FRONTIER_CLI_PATH } from "./frontier-cli.js"
import { MEMORY_CLI_PATH } from "./memory-cli.js"
import { CharacterLog } from "../logging/log-writer.js"
import { OAuthToken } from "../services/OAuthToken.js"
import { Docker } from "../services/Docker.js"
import { DEFAULT_CORTEX_MODELS } from "../model/handles.js"
import * as core from "../index.js"
import type { TurnResult } from "../core/limbic/hypothalamus/types.js"

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

  it("execs the memory CLI provisioning AS ROOT (the /usr/local/bin permission fix)", async () => {
    const calls: { command: string[]; user?: string }[] = []
    const StubDockerCapturing = Layer.succeed(
      Docker,
      Docker.of({
        exec: (_id: string, command: string[], execOpts?: { user?: string }) => {
          calls.push({ command, user: execOpts?.user })
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
    const memoryCall = calls.find((c) => c.command.join(" ").includes(MEMORY_CLI_PATH))
    expect(memoryCall).toBeDefined()
    expect(memoryCall!.user).toBe("root")
  })

  it("logs a STRUCTURED error and still returns void when memory provisioning fails", async () => {
    // Fail ONLY the memory CLI exec; the provider/frontier execs succeed.
    const FailMemoryDocker = Layer.succeed(
      Docker,
      Docker.of({
        exec: (_id: string, command: string[]) =>
          command.join(" ").includes(MEMORY_CLI_PATH)
            ? Effect.fail(new Error("Permission denied"))
            : Effect.succeed(""),
      } as unknown as typeof Docker.Service),
    )
    const errorMessages: string[] = []
    const recordingLog = Layer.succeed(
      CharacterLog,
      CharacterLog.of({
        emit: (_c, e) => Effect.sync(() => { if (e.kind === "error") errorMessages.push(e.message) }),
      }),
    )
    const tempDir = mkdtempSync(nodePath.join(tmpdir(), "roci-test-"))
    const program = Effect.gen(function* () {
      const ct = yield* ConsciousThought
      yield* ct.provision(provisionOpts(tempDir))
    })
    // Must NOT throw — provisioning is best-effort, the loop keeps running.
    await Effect.runPromise(
      Effect.provide(program, Layer.mergeAll(ConsciousThoughtLive, FailMemoryDocker, recordingLog)),
    )
    expect(errorMessages.some((m) => m.toLowerCase().includes("memory cli provisioning failed"))).toBe(true)
  })
})
