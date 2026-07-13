import { describe, it, expect } from "vitest"
import {
  DEFAULT_CORTEX_MODELS,
  resolveHandle,
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
  // silently truncate output. Forebrain thinking is OFF: the initial spike saw
  // 326-579 token orient responses, but a live run hit finish=length at 1024 and
  // lost the assessment, so the cap is now 2048 (headroom, paired with a terse
  // prompt budget + truncation salvage in the orient parse path). Hindbrain is
  // 1024; conscious is 16384.
  it("pins an explicit maxTokens budget on every local tier", () => {
    expect(DEFAULT_CORTEX_MODELS.hindbrain.params?.maxTokens).toBeGreaterThanOrEqual(1024)
    expect(DEFAULT_CORTEX_MODELS.forebrain.params?.maxTokens).toBe(2048)
    expect(DEFAULT_CORTEX_MODELS.conscious.params?.maxTokens).toBeGreaterThanOrEqual(1024)
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
