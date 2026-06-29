import { describe, it, expect } from "vitest"
import {
  DEFAULT_CORTEX_MODELS,
  resolveHandle,
  mergeCortexModels,
  isReasoningModel,
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

  // Every tier must declare an explicit maxTokens so the server default can never
  // silently truncate output. Forebrain thinking is OFF: 1024 is ~1.8x the observed
  // max for thinking-off orient responses (326-579 tokens). Hindbrain is 4096;
  // conscious is 16384.
  it("pins an explicit maxTokens budget on every local tier", () => {
    expect(DEFAULT_CORTEX_MODELS.hindbrain.params?.maxTokens).toBeGreaterThanOrEqual(1024)
    expect(DEFAULT_CORTEX_MODELS.forebrain.params?.maxTokens).toBe(1024)
    expect(DEFAULT_CORTEX_MODELS.conscious.params?.maxTokens).toBeGreaterThanOrEqual(1024)
  })

  // Run-2 QA finding: hindbrain (observe) and forebrain (orient) must emit a
  // parseable JSON result every tick (parseOr otherwise degrades to a "parse
  // failure" fallback). Reasoning models burn the token budget on a variable
  // chain-of-thought and intermittently hit finish=length with empty content
  // (directly observed: GLM-4.7-Flash failed 2/6 orient probes). Guard the
  // defaults for these structured-output tiers against regressing to a
  // reasoning model.
  //
  // The conscious tier is the designated deep-thinker, but as of
  // gemma-4-31b-it-8bit it is an instruction-tuned model (no chain-of-thought
  // regime), so isReasoningModel returns false for it too.
  it("guards hindbrain/forebrain as non-reasoning; conscious (gemma-4-31b-it) is also not", () => {
    expect(isReasoningModel(DEFAULT_CORTEX_MODELS.hindbrain.model)).toBe(false)
    expect(isReasoningModel(DEFAULT_CORTEX_MODELS.forebrain.model)).toBe(false)
    expect(isReasoningModel(DEFAULT_CORTEX_MODELS.conscious.model)).toBe(false)
  })

  it("pins hindbrain/forebrain to the Qwen3.5 ladder and conscious to gemma-4-31b-it", () => {
    expect(DEFAULT_CORTEX_MODELS.hindbrain.model).toBe("mlx-community/Qwen3.5-2B-4bit")
    expect(DEFAULT_CORTEX_MODELS.forebrain.model).toBe("mlx-community/Qwen3.5-9B-4bit")
    expect(DEFAULT_CORTEX_MODELS.conscious.model).toBe("mlx-community/gemma-4-31b-it-8bit")
  })

  // The Qwen3.5 ladder models are "thinking" models (enable_thinking defaults ON).
  // Measured across 5 orient scenarios (blind-judged): thinking-ON ran 3,640-16,384
  // tokens (41-213s); on complex multi-threaded inputs the monologue hit the cap
  // (finish=length) and never emitted closing JSON — a hard parse failure. This mlx
  // stack has NO constrained decoding to prevent it. Thinking-OFF produced valid JSON
  // every run (326-579 tokens, 4-7s) and was equal-or-better on 4 of 5 scenarios.
  // Both structured-output tiers now DISABLE thinking; ambiguity-discipline is
  // recovered in the orient prompt instead of the CoT monologue.
  it("disables thinking on both hindbrain and forebrain", () => {
    expect(DEFAULT_CORTEX_MODELS.hindbrain.params?.extraBody).toEqual({
      chat_template_kwargs: { enable_thinking: false },
    })
    expect(DEFAULT_CORTEX_MODELS.forebrain.params?.extraBody).toEqual({
      chat_template_kwargs: { enable_thinking: false },
    })
    // Drill the nested shape explicitly so a regression in the exact path the
    // chat template reads is caught.
    const hindKwargs = DEFAULT_CORTEX_MODELS.hindbrain.params?.extraBody?.chat_template_kwargs as
      | { enable_thinking?: boolean }
      | undefined
    const foreKwargs = DEFAULT_CORTEX_MODELS.forebrain.params?.extraBody?.chat_template_kwargs as
      | { enable_thinking?: boolean }
      | undefined
    expect(hindKwargs?.enable_thinking).toBe(false)
    expect(foreKwargs?.enable_thinking).toBe(false)
  })

  // conscious (decide/evaluate) is the designated deep-reasoner and must KEEP
  // thinking: no extraBody → no chat_template_kwargs → thinking stays ON.
  it("keeps thinking enabled on the conscious tier (no extraBody)", () => {
    expect(DEFAULT_CORTEX_MODELS.conscious.params?.extraBody).toBeUndefined()
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
