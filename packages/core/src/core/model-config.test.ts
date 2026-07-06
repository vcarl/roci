import { describe, it, expect } from "vitest"
import {
  DEFAULT_MODEL_CONFIG,
  resolveModel,
  assertValidModelConfig,
  ModelConfigError,
  type ModelConfig,
} from "./model-config.js"
import { DEFAULT_CORTEX_MODELS } from "../model/handles.js"
import { consciousModelLabel } from "../model/conscious-label.js"

describe("resolveModel", () => {
  const base: ModelConfig = {
    tiers: { fast: "haiku", smart: "sonnet", reasoning: "opus" },
  }

  it("uses the default tier when no override exists", () => {
    expect(resolveModel(base, "dreamCompression", "smart")).toBe("sonnet")
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
    const config: ModelConfig = { ...base, roles: { dreamCompression: undefined } }
    expect(resolveModel(config, "dreamCompression", "smart")).toBe("sonnet")
  })

  it("resolves a role override that names a tier to that tier's model (tier-name-or-model-string contract)", () => {
    // Design contract: per-role overrides resolve as TIER NAME or model string.
    // `roles: { macro: "reasoning" }` must follow the reasoning tier's model, not
    // be treated as a literal model called "reasoning".
    const config: ModelConfig = {
      tiers: { fast: "haiku", smart: "sonnet", reasoning: "claude-opus-4-6" },
      roles: { macro: "reasoning" },
    }
    expect(resolveModel(config, "macro", "smart")).toBe("claude-opus-4-6")
  })

  it("a tier-name role override wins over the supplied default tier", () => {
    const config: ModelConfig = {
      tiers: { fast: "haiku", smart: "sonnet", reasoning: "opus" },
      roles: { retrospect: "fast" },
    }
    expect(resolveModel(config, "retrospect", "smart")).toBe("haiku")
  })

  it("respects custom tier values", () => {
    const config: ModelConfig = {
      tiers: { fast: "haiku", smart: "opus", reasoning: "opus" },
    }
    expect(resolveModel(config, "dreamCompression", "smart")).toBe("opus")
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
    // The resolved dreamCompression model must NEVER be a Claude tier (no claude runtime
    // in the reflection path).
    expect(["haiku", "sonnet", "opus"]).not.toContain(
      resolveModel(DEFAULT_MODEL_CONFIG, "dreamCompression", "smart"),
    )
  })
})

describe("assertValidModelConfig", () => {
  it("accepts the built-in default config", () => {
    // The shipped default (alias tiers + a local/ dreamCompression override) must
    // always pass its own validation.
    expect(() => assertValidModelConfig(DEFAULT_MODEL_CONFIG)).not.toThrow()
  })

  it("accepts alias tiers", () => {
    const config: ModelConfig = { tiers: { fast: "haiku", smart: "sonnet", reasoning: "opus" } }
    expect(() => assertValidModelConfig(config)).not.toThrow()
  })

  it("accepts a fully-qualified claude-* id as a tier override", () => {
    // The exact misroute case: a legal `--tier-reasoning claude-opus-4-6` override.
    // It must validate (and, per runtime.test, route to the claude binary).
    const config: ModelConfig = {
      tiers: { fast: "haiku", smart: "sonnet", reasoning: "claude-opus-4-6" },
    }
    expect(() => assertValidModelConfig(config)).not.toThrow()
  })

  it("accepts a provider/model per-role override and the local dreamCompression default", () => {
    const config: ModelConfig = {
      tiers: { fast: "haiku", smart: "sonnet", reasoning: "opus" },
      roles: {
        dreamCompression: "local/mlx-community/gemma-4-31b-it-8bit",
        macro: "openrouter/anthropic/claude-sonnet-4",
      },
    }
    expect(() => assertValidModelConfig(config)).not.toThrow()
  })

  it("throws ModelConfigError naming the offending tier for an arbitrary garbage string", () => {
    const config: ModelConfig = {
      tiers: { fast: "haiku", smart: "sonnet", reasoning: "totally-made-up" },
    }
    expect(() => assertValidModelConfig(config)).toThrow(ModelConfigError)
    try {
      assertValidModelConfig(config)
      throw new Error("expected assertValidModelConfig to throw")
    } catch (e) {
      const msg = String(e)
      expect(msg).toContain("tiers.reasoning")
      expect(msg).toContain("totally-made-up")
      // Actionable: names the accepted forms.
      expect(msg).toMatch(/opus/)
      expect(msg).toMatch(/provider\/model/)
    }
  })

  it("throws for a bare, provider-less non-Claude name (must not misroute to opencode)", () => {
    const config: ModelConfig = {
      tiers: { fast: "haiku", smart: "sonnet", reasoning: "opus" },
      roles: { macro: "gpt-4o" },
    }
    expect(() => assertValidModelConfig(config)).toThrow(ModelConfigError)
    try {
      assertValidModelConfig(config)
    } catch (e) {
      expect(String(e)).toContain("roles.macro")
    }
  })

  it("ignores undefined per-role overrides (they fall back to a tier)", () => {
    const config: ModelConfig = {
      tiers: { fast: "haiku", smart: "sonnet", reasoning: "opus" },
      roles: { dreamCompression: undefined },
    }
    expect(() => assertValidModelConfig(config)).not.toThrow()
  })

  it("accepts a tier name in a role position (legal-by-design indirection)", () => {
    const config: ModelConfig = {
      tiers: { fast: "haiku", smart: "sonnet", reasoning: "claude-opus-4-6" },
      roles: { macro: "reasoning", retrospect: "fast" },
    }
    expect(() => assertValidModelConfig(config)).not.toThrow()
  })

  it("a tier-name role override pointing at an invalid tier value fails on the TIER entry, not the role", () => {
    // Validation follows resolution: the role override "reasoning" is fine as
    // indirection; the broken thing is what it resolves to (tiers.reasoning).
    const config: ModelConfig = {
      tiers: { fast: "haiku", smart: "sonnet", reasoning: "totally-made-up" },
      roles: { macro: "reasoning" },
    }
    expect(() => assertValidModelConfig(config)).toThrow(ModelConfigError)
    try {
      assertValidModelConfig(config)
      throw new Error("expected assertValidModelConfig to throw")
    } catch (e) {
      const msg = String(e)
      expect(msg).toContain("tiers.reasoning")
      expect(msg).not.toContain("roles.macro")
    }
  })
})
