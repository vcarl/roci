import { describe, it, expect } from "vitest"
import { DEFAULT_MODEL_CONFIG, resolveModel, type ModelConfig } from "./model-config.js"
import { DEFAULT_CORTEX_MODELS } from "../model/handles.js"
import { consciousModelLabel } from "../conscious/opencode-config.js"

describe("resolveModel", () => {
  const base: ModelConfig = {
    tiers: { fast: "haiku", smart: "sonnet", reasoning: "opus" },
  }

  it("uses the default tier when no override exists", () => {
    expect(resolveModel(base, "dinner", "smart")).toBe("sonnet")
    expect(resolveModel(base, "dreamCompression", "reasoning")).toBe("opus")
  })

  it("returns a raw-model override verbatim", () => {
    const config: ModelConfig = {
      ...base,
      roles: { dreamCompression: "openrouter/anthropic/claude-sonnet-4" },
    }
    expect(resolveModel(config, "dreamCompression", "smart")).toBe(
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
    expect(resolveModel(config, "dinner", "smart")).toBe("opus")
  })

  it("routes dreamCompression to the local conscious mlx model by default", () => {
    // Single source of truth: the default is DERIVED from the conscious handle,
    // so this equality can never drift from the model the cortex serves.
    expect(resolveModel(DEFAULT_MODEL_CONFIG, "dreamCompression", "smart")).toBe(
      consciousModelLabel(DEFAULT_CORTEX_MODELS.conscious),
    )
    expect(resolveModel(DEFAULT_MODEL_CONFIG, "dreamCompression", "smart")).toBe(
      "local/mlx-community/gemma-4-31b-it-8bit",
    )
  })
})
