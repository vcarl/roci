import { describe, it, expect } from "vitest"
import { MODEL_TIER_SPECS, resolveTierSpec } from "./model-tier-spec.js"
import { DEFAULT_CORTEX_MODELS } from "../model/handles.js"

describe("MODEL_TIER_SPECS", () => {
  it("pins conscious to the resident gemma-4-31b on port 8083", () => {
    const c = MODEL_TIER_SPECS.conscious
    expect(c.model).toBe("mlx-community/gemma-4-31b-it-8bit")
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

  // C0 regression guard: the spawner (TierSpec) and the consumer (handles) must
  // never advertise a different model or endpoint for the same tier, or the
  // server we spawn answers a model the cortex never calls. The spec now DERIVES
  // both from DEFAULT_CORTEX_MODELS, so this can only fail if someone reintroduces
  // a second source of truth.
  it("derives model and baseUrl from handles for every tier (single source of truth)", () => {
    for (const tier of ["hindbrain", "forebrain", "conscious"] as const) {
      const spec = resolveTierSpec(tier)
      const handle = DEFAULT_CORTEX_MODELS[tier]
      expect(spec.model).toBe(handle.model)
      expect(spec.baseUrl).toBe(handle.baseUrl)
    }
  })
})
