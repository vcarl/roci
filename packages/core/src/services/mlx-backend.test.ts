import { describe, it, expect } from "vitest"
import { buildMlxArgs, buildProbeRequest } from "./mlx-backend.js"
import { resolveTierSpec } from "./model-tier-spec.js"

describe("buildMlxArgs", () => {
  it("builds mlx_lm.server --model <id> --port <p> for the conscious tier", () => {
    const args = buildMlxArgs(resolveTierSpec("conscious"))
    expect(args).toEqual([
      "--model", "mlx-community/Qwen3.5-122B-A10B-4bit",
      "--port", "8083",
    ])
  })
  it("appends spawnArgs after the base flags", () => {
    const spec = { ...resolveTierSpec("hindbrain"), spawnArgs: ["--trust-remote-code"] as const }
    expect(buildMlxArgs(spec)).toEqual([
      "--model", "mlx-community/Qwen3.5-2B-4bit",
      "--port", "8081",
      "--trust-remote-code",
    ])
  })
})

describe("buildProbeRequest", () => {
  it("targets /chat/completions with a 1-token generate (NOT /v1/models)", () => {
    const { url, body } = buildProbeRequest(resolveTierSpec("forebrain"))
    expect(url).toBe("http://127.0.0.1:8082/v1/chat/completions")
    expect(url).not.toContain("/models")
    expect(body.max_tokens).toBe(1)
    expect(body.model).toBe("mlx-community/Qwen3.5-9B-4bit")
    expect(body.stream).toBe(false)
  })
})
