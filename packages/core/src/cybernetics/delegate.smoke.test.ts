import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { NodeContext, NodeFileSystem } from "@effect/platform-node"
import { Cybernetics, CyberneticsLive } from "./delegate.js"
import { CharacterLogLive } from "../logging/log-writer.js"
import { OAuthTokenLive } from "../services/OAuthToken.js"
import { ProjectRoot } from "../services/ProjectRoot.js"
import type { DelegationConfig } from "./types.js"

// ROCI_CYBERNETICS_CONTAINER=<containerId> npx vitest run packages/core/src/cybernetics/delegate.smoke.test.ts
const containerId = process.env.ROCI_CYBERNETICS_CONTAINER
const playerName = process.env.ROCI_CYBERNETICS_PLAYER ?? "test-pilot"

describe.skipIf(!containerId)("Cybernetics.delegate against a real container", () => {
  it("runs a trivial task to completion", async () => {
    const cfg: DelegationConfig = {
      containerId: containerId as string,
      playerName,
      char: { name: playerName, dir: `/work/players/${playerName}/me` },
      task: "Print the single word: pong. Do nothing else.",
      systemPrompt: "You are a terse assistant.",
      model: "sonnet",
      timeoutMs: 120_000,
    }

    const projectRootLayer = Layer.succeed(ProjectRoot, process.cwd())

    const characterLogLayer = CharacterLogLive.pipe(
      Layer.provide(Layer.mergeAll(projectRootLayer, NodeFileSystem.layer)),
    )

    const oauthTokenLayer = OAuthTokenLive.pipe(
      Layer.provide(Layer.mergeAll(projectRootLayer, characterLogLayer)),
    )

    const deps = Layer.mergeAll(
      NodeContext.layer,
      characterLogLayer,
      oauthTokenLayer,
    )

    const program = Effect.gen(function* () {
      const cyb = yield* Cybernetics
      return yield* cyb.delegate(cfg)
    })
    const result = await Effect.runPromise(
      Effect.provide(program, Layer.merge(CyberneticsLive, deps)),
    )
    expect(["completed", "timed_out"]).toContain(result.status)
  }, 130_000)
})
