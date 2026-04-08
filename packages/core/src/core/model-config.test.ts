import { describe, it, expect } from "vitest"
import {
  DEFAULT_MODEL_CONFIG,
  isTier,
  mergeModelConfig,
  resolveModel,
  type ModelConfig,
} from "./model-config.js"

describe("isTier", () => {
  it("returns true for known tier names", () => {
    expect(isTier("fast")).toBe(true)
    expect(isTier("smart")).toBe(true)
    expect(isTier("reasoning")).toBe(true)
  })

  it("returns false for raw model strings", () => {
    expect(isTier("opus")).toBe(false)
    expect(isTier("openrouter/anthropic/claude-sonnet-4")).toBe(false)
    expect(isTier("")).toBe(false)
  })
})

describe("resolveModel", () => {
  const base: ModelConfig = {
    tiers: { fast: "haiku", smart: "sonnet", reasoning: "opus" },
  }

  it("uses the default tier when no override exists", () => {
    expect(resolveModel(base, "brainPlan", "reasoning")).toBe("opus")
    expect(resolveModel(base, "timeoutSummary", "fast")).toBe("haiku")
    expect(resolveModel(base, "dreamCompression", "smart")).toBe("sonnet")
  })

  it("resolves a tier-name override to the configured tier model", () => {
    const config: ModelConfig = {
      ...base,
      roles: { dreamCompression: "fast" },
    }
    expect(resolveModel(config, "dreamCompression", "smart")).toBe("haiku")
  })

  it("returns a raw-model override verbatim", () => {
    const config: ModelConfig = {
      ...base,
      roles: { brainPlan: "openrouter/anthropic/claude-sonnet-4" },
    }
    expect(resolveModel(config, "brainPlan", "reasoning")).toBe(
      "openrouter/anthropic/claude-sonnet-4",
    )
  })

  it("falls back to the default tier when an override is undefined", () => {
    const config: ModelConfig = { ...base, roles: { dinner: undefined } }
    expect(resolveModel(config, "dinner", "smart")).toBe("sonnet")
  })

  it("respects custom tier values", () => {
    const config: ModelConfig = {
      tiers: { fast: "haiku", smart: "opus", reasoning: "opus" },
    }
    expect(resolveModel(config, "brainPlan", "smart")).toBe("opus")
  })
})

describe("mergeModelConfig", () => {
  it("returns defaults unchanged when no overlay supplied", () => {
    expect(mergeModelConfig(DEFAULT_MODEL_CONFIG, undefined)).toEqual(
      DEFAULT_MODEL_CONFIG,
    )
  })

  it("overlays tier values", () => {
    const merged = mergeModelConfig(DEFAULT_MODEL_CONFIG, {
      tiers: { smart: "opus" },
    })
    expect(merged.tiers).toEqual({
      fast: "haiku",
      smart: "opus",
      reasoning: "opus",
    })
  })

  it("overlays role overrides", () => {
    const merged = mergeModelConfig(DEFAULT_MODEL_CONFIG, {
      roles: { brainPlan: "fast", dinner: "openrouter/x" },
    })
    expect(merged.roles?.brainPlan).toBe("fast")
    expect(merged.roles?.dinner).toBe("openrouter/x")
  })

  it("merges roles additively without dropping existing keys", () => {
    const base: ModelConfig = {
      tiers: DEFAULT_MODEL_CONFIG.tiers,
      roles: { brainPlan: "smart" },
    }
    const merged = mergeModelConfig(base, { roles: { dinner: "fast" } })
    expect(merged.roles?.brainPlan).toBe("smart")
    expect(merged.roles?.dinner).toBe("fast")
  })
})
