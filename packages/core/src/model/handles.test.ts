import { describe, it, expect } from "vitest"
import {
  DEFAULT_CORTEX_MODELS,
  resolveHandle,
  mergeCortexModels,
  type CortexModelConfig,
} from "./handles.js"

const base: CortexModelConfig = {
  hindbrain: { tier: "hindbrain", provider: "mlx", baseUrl: "http://127.0.0.1:8081/v1", model: "hind" },
  forebrain: { tier: "forebrain", provider: "mlx", baseUrl: "http://127.0.0.1:8082/v1", model: "fore" },
  conscious: { tier: "conscious", provider: "mlx", baseUrl: "http://127.0.0.1:8083/v1", model: "consc" },
}

describe("resolveHandle", () => {
  it("returns the handle for the requested tier", () => {
    expect(resolveHandle(base, "forebrain").model).toBe("fore")
    expect(resolveHandle(base, "conscious").baseUrl).toBe("http://127.0.0.1:8083/v1")
  })
})

describe("DEFAULT_CORTEX_MODELS", () => {
  it("defines all three tiers with localhost endpoints", () => {
    for (const tier of ["hindbrain", "forebrain", "conscious"] as const) {
      const h = DEFAULT_CORTEX_MODELS[tier]
      expect(h.tier).toBe(tier)
      expect(h.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/)
      expect(h.model.length).toBeGreaterThan(0)
    }
  })
})

describe("mergeCortexModels", () => {
  it("returns base unchanged when no overlay", () => {
    expect(mergeCortexModels(base, undefined)).toEqual(base)
  })

  it("overlays a single field on one tier without touching others", () => {
    const merged = mergeCortexModels(base, { conscious: { model: "gpt-oss-120b" } })
    expect(merged.conscious.model).toBe("gpt-oss-120b")
    expect(merged.conscious.baseUrl).toBe("http://127.0.0.1:8083/v1") // preserved
    expect(merged.hindbrain).toEqual(base.hindbrain) // untouched
  })

  it("can repoint a tier at a remote provider", () => {
    const merged = mergeCortexModels(base, {
      conscious: { provider: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-4", apiKey: "sk-x" },
    })
    expect(merged.conscious.provider).toBe("openai-compatible")
    expect(merged.conscious.apiKey).toBe("sk-x")
  })
})
