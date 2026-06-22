import { describe, it, expect } from "vitest"
import { MODEL_TIER_SPECS, resolveTierSpec } from "./model-tier-spec.js"

describe("MODEL_TIER_SPECS", () => {
  it("pins conscious to the resident 122B on port 8083", () => {
    const c = MODEL_TIER_SPECS.conscious
    expect(c.model).toBe("mlx-community/Qwen3.5-122B-A10B-4bit")
    expect(c.port).toBe(8083)
    expect(c.lifecycle).toBe("resident")
    expect(c.baseUrl).toBe("http://127.0.0.1:8083/v1")
  })
  it("makes forebrain the per-phase 9B on 8082 and hindbrain the per-phase 2B on 8081", () => {
    expect(MODEL_TIER_SPECS.forebrain.model).toBe("mlx-community/Qwen3.5-9B-4bit")
    expect(MODEL_TIER_SPECS.forebrain.port).toBe(8082)
    expect(MODEL_TIER_SPECS.forebrain.lifecycle).toBe("per-phase")
    expect(MODEL_TIER_SPECS.hindbrain.model).toBe("mlx-community/Qwen3.5-2B-4bit")
    expect(MODEL_TIER_SPECS.hindbrain.port).toBe(8081)
    expect(MODEL_TIER_SPECS.hindbrain.lifecycle).toBe("per-phase")
  })
  it("gives every tier a positive readiness timeout", () => {
    for (const t of ["hindbrain", "forebrain", "conscious"] as const) {
      expect(MODEL_TIER_SPECS[t].timeoutMs).toBeGreaterThan(0)
    }
  })
  it("resolveTierSpec returns the matching spec", () => {
    expect(resolveTierSpec("conscious")).toBe(MODEL_TIER_SPECS.conscious)
  })
})
