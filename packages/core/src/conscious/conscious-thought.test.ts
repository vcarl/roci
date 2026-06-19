import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { CommandExecutor } from "@effect/platform"
import { ConsciousThought, ConsciousThoughtTest } from "./conscious-thought.js"
import { CharacterLog } from "../logging/log-writer.js"
import { OAuthToken } from "../services/OAuthToken.js"
import { Docker } from "../services/Docker.js"
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
    const captured: string[] = []
    const layer = Layer.merge(
      ConsciousThoughtTest(
        () => ({ result: cannedResult, sessionId: "ses_001" }),
        (directive) => captured.push(directive),
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
          })
        }),
        errorLayer,
      ),
    )
    expect(result.result.output).toBe("auth error")
    expect(result.sessionId).toBe("error-sentinel")
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
            })
          }),
          layer,
        ),
      ),
    ).resolves.not.toThrow()
  })
})
