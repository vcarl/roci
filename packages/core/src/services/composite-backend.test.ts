import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import type { ModelProvider } from "../model/handles.js"
import type { TierSpec } from "./model-tier-spec.js"
import type { ModelBackend, RunningServer } from "./model-backend.js"
import { makeCompositeBackend } from "./composite-backend.js"

// A ModelBackend that records which of its methods were called (and with what
// spec/server), so we can assert the composite dispatched to the RIGHT backend by
// provider. Every method returns a harmless value tagged with the backend's name.
function recordingBackend(name: string) {
  const calls: Array<{ method: string; provider: ModelProvider }> = []
  const backend: ModelBackend = {
    spawn: (spec) => {
      calls.push({ method: "spawn", provider: spec.provider })
      return Effect.succeed({ spec, spawned: true, pid: 1 } as RunningServer)
    },
    readinessProbe: (spec) => {
      calls.push({ method: "readinessProbe", provider: spec.provider })
      return Effect.void
    },
    readinessProbeFor: (server) => {
      calls.push({ method: "readinessProbeFor", provider: server.spec.provider })
      return Effect.void
    },
    kill: (server) => {
      calls.push({ method: "kill", provider: server.spec.provider })
      return Effect.void
    },
    isHealthy: (spec) => {
      calls.push({ method: "isHealthy", provider: spec.provider })
      return Effect.succeed(true)
    },
  }
  return { backend, calls, name }
}

const specFor = (provider: ModelProvider): TierSpec => ({
  tier: provider === "llamacpp" ? "conscious" : "hindbrain",
  model: provider === "llamacpp" ? "unsloth/gpt-oss-20b-GGUF" : "mlx-community/Qwen3.5-2B-4bit",
  provider,
  port: provider === "llamacpp" ? 8083 : 8081,
  baseUrl: provider === "llamacpp" ? "http://127.0.0.1:8083/v1" : "http://127.0.0.1:8081/v1",
  spawnArgs: [],
  lifecycle: provider === "llamacpp" ? "resident" : "per-phase",
  timeoutMs: 1000,
})

const serverFor = (provider: ModelProvider): RunningServer => ({
  spec: specFor(provider),
  spawned: true,
  pid: 42,
})

describe("makeCompositeBackend", () => {
  const build = () => {
    const mlx = recordingBackend("mlx")
    const llama = recordingBackend("llama")
    const composite = makeCompositeBackend({
      mlx: mlx.backend,
      llamacpp: llama.backend,
      "openai-compatible": mlx.backend,
    })
    return { mlx, llama, composite }
  }

  it("dispatches spec-taking methods by spec.provider", async () => {
    const { mlx, llama, composite } = build()
    await Effect.runPromise(Effect.scoped(composite.spawn(specFor("llamacpp"))))
    await Effect.runPromise(composite.readinessProbe(specFor("llamacpp")))
    await Effect.runPromise(composite.isHealthy(specFor("mlx")))

    expect(llama.calls).toEqual([
      { method: "spawn", provider: "llamacpp" },
      { method: "readinessProbe", provider: "llamacpp" },
    ])
    expect(mlx.calls).toEqual([{ method: "isHealthy", provider: "mlx" }])
  })

  it("dispatches server-taking methods by server.spec.provider", async () => {
    const { mlx, llama, composite } = build()
    await Effect.runPromise(composite.kill(serverFor("llamacpp")))
    await Effect.runPromise(composite.readinessProbeFor!(serverFor("mlx")))

    expect(llama.calls).toEqual([{ method: "kill", provider: "llamacpp" }])
    expect(mlx.calls).toEqual([{ method: "readinessProbeFor", provider: "mlx" }])
  })

  it("routes conscious (llamacpp) to the llama backend and the light tiers (mlx) to the mlx backend for spawn", async () => {
    const { mlx, llama, composite } = build()
    await Effect.runPromise(Effect.scoped(composite.spawn(specFor("mlx"))))
    await Effect.runPromise(Effect.scoped(composite.spawn(specFor("llamacpp"))))

    expect(mlx.calls.map((c) => c.method)).toEqual(["spawn"])
    expect(llama.calls.map((c) => c.method)).toEqual(["spawn"])
  })
})
