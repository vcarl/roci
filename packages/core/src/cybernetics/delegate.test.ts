import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { CommandExecutor } from "@effect/platform"
import { Cybernetics, CyberneticsTest } from "./delegate.js"
import { CharacterLog } from "../logging/log-writer.js"
import { OAuthToken } from "../services/OAuthToken.js"
import type { DelegationConfig } from "./types.js"

// Minimal no-op stubs to satisfy the service interface requirements that the
// Cybernetics Tag declares on delegate's return type. The CyberneticsTest layer
// never calls runTurn so these stubs are never invoked at runtime.
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
const testDeps = Layer.mergeAll(StubCommandExecutor, StubCharacterLog, StubOAuthToken)

const cfg: DelegationConfig = {
  containerId: "c1",
  playerName: "ada",
  char: { name: "ada", dir: "/work/players/ada/me" },
  task: "fix the failing test",
  systemPrompt: "you are an engineer",
  model: "sonnet",
  timeoutMs: 1000,
}

describe("Cybernetics service contract", () => {
  it("delegate returns the canned result from the provided implementation", async () => {
    const layer = Layer.merge(
      CyberneticsTest((c) => ({
        status: "completed",
        output: `did: ${c.task}`,
        durationMs: 42,
      })),
      testDeps,
    )
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const cyb = yield* Cybernetics
          return yield* cyb.delegate(cfg)
        }),
        layer,
      ),
    )
    expect(result).toEqual({ status: "completed", output: "did: fix the failing test", durationMs: 42 })
  })

  it("delegate can report a failed status", async () => {
    const layer = Layer.merge(
      CyberneticsTest(() => ({ status: "failed", output: "auth error", durationMs: 5 })),
      testDeps,
    )
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const cyb = yield* Cybernetics
          return yield* cyb.delegate(cfg)
        }),
        layer,
      ),
    )
    expect(result.status).toBe("failed")
  })
})
