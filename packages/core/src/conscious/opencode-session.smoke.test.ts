import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { NodeContext, NodeFileSystem } from "@effect/platform-node"
import { runOpenCodeSessionTurn } from "../core/limbic/hypothalamus/process-runner.js"
import {
  provisionConsciousProvider,
  writeCharacterAgentFile,
  CONSCIOUS_AGENT_NAME,
  CONSCIOUS_MODEL_LABEL,
} from "./opencode-config.js"
import { DockerLive } from "../services/Docker.js"
import { DEFAULT_CORTEX_MODELS } from "../model/handles.js"
import { CharacterLogLive } from "../logging/log-writer.js"
import { OAuthTokenLive } from "../services/OAuthToken.js"
import { ProjectRoot } from "../services/ProjectRoot.js"
import type { TurnConfig } from "../core/limbic/hypothalamus/types.js"

// Prereqs: a host llama-server on the conscious port, and a roci container:
//   ROCI_OPENCODE_SESSION_CONTAINER=<id> ROCI_OPENCODE_SESSION_PLAYER=<name> \
//   pnpm --filter @roci/core test opencode-session.smoke
const containerId = process.env.ROCI_OPENCODE_SESSION_CONTAINER
const playerName = process.env.ROCI_OPENCODE_SESSION_PLAYER ?? "test-pilot"

describe.skipIf(!containerId)("OpenCode conscious session (real container)", () => {
  it("opens a session, then a resume turn recalls turn-1 context", async () => {
    const projectRootLayer = Layer.succeed(ProjectRoot, process.cwd())
    const characterLogLayer = CharacterLogLive.pipe(
      Layer.provide(Layer.mergeAll(projectRootLayer, NodeFileSystem.layer)),
    )
    const oauthTokenLayer = OAuthTokenLive.pipe(
      Layer.provide(Layer.mergeAll(projectRootLayer, characterLogLayer)),
    )
    const dockerLayer = DockerLive.pipe(Layer.provide(NodeContext.layer))
    const deps = Layer.mergeAll(NodeContext.layer, dockerLayer, characterLogLayer, oauthTokenLayer)

    // Provision provider (global) + agent (project-local under <cwd>/players/<name>).
    writeCharacterAgentFile({
      playersDir: `${process.cwd()}/players`,
      playerName,
      systemPrompt: "You are a terse test agent. Answer in one short sentence.",
    })

    const char = { name: playerName, dir: `/work/players/${playerName}/me` }
    const base: TurnConfig = {
      containerId: containerId as string,
      playerName,
      char,
      systemPrompt: "",
      model: CONSCIOUS_MODEL_LABEL,
      agentName: CONSCIOUS_AGENT_NAME,
      prompt: "Remember this codeword: BANANA. Acknowledge.",
      timeoutMs: 120_000,
      role: "body",
    }

    const program = Effect.gen(function* () {
      yield* provisionConsciousProvider(containerId as string, DEFAULT_CORTEX_MODELS.conscious)
      const first = yield* runOpenCodeSessionTurn(base)
      const second = yield* runOpenCodeSessionTurn(
        { ...base, prompt: "What was the codeword I gave you?" },
        { sessionId: first.sessionId },
      )
      return { first, second }
    })

    const { first, second } = await Effect.runPromise(Effect.provide(program, deps))
    expect(first.sessionId).toMatch(/^ses_/)
    expect(second.sessionId).toBe(first.sessionId)
    expect(second.result.output.toUpperCase()).toContain("BANANA")
  }, 300_000)
})
