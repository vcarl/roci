/** Cortex cognition tiers. Distinct from the legacy fast/smart/reasoning tiers. */
export type CortexTier = "hindbrain" | "forebrain" | "conscious"

/**
 * Serving provider for a model. All three are reached over the same
 * OpenAI-compatible HTTP API; the value is metadata for logging/serving and
 * does not change how ModelClient forms the request.
 */
export type ModelProvider = "mlx" | "llamacpp" | "openai-compatible"

export interface ModelParams {
  temperature?: number
  maxTokens?: number
  /**
   * Extra OpenAI-compatible body fields merged verbatim into the request
   * (e.g. mlx_lm's `chat_template_kwargs`, or llama.cpp's `grammar`/`json_schema`).
   *
   * NOTE: `response_format` (JSON-schema / grammar-constrained decoding) is NOT
   * supported on the mlx provider — mlx_lm 0.31.2 has no constrained-decoding
   * backend, so the server silently ignores the key (it does NOT enforce the
   * schema). It would only take effect against a llama.cpp server, which does
   * have a grammar/json_schema backend. Do not re-add `response_format` to an
   * mlx tier expecting it to work; rely on the tolerant JSON extractor instead.
   */
  extraBody?: Record<string, unknown>
}

export interface ModelHandle {
  tier: CortexTier
  provider: ModelProvider
  /** OpenAI-compatible base URL including the version path, e.g. "http://127.0.0.1:8081/v1". */
  baseUrl: string
  model: string
  apiKey?: string
  params?: ModelParams
}

export type CortexModelConfig = Record<CortexTier, ModelHandle>

/** Partial overlay applied per tier (from a config file or CLI flags). */
export interface CortexModelOverlay {
  hindbrain?: Partial<ModelHandle>
  forebrain?: Partial<ModelHandle>
  conscious?: Partial<ModelHandle>
}

/**
 * Default local config for Apple Silicon (M5 / 128GB). Model names are
 * starting points to be tuned empirically by the testbench
 * (~/workspace/testbench/llms); ports assume one server process per resident
 * tier. The serving topology (which ports, on-demand loading) is configured
 * externally, not by this module.
 */
export const DEFAULT_CORTEX_MODELS: CortexModelConfig = {
  // hindbrain (observe) and forebrain (orient) must emit a parseable JSON result
  // every tick (parseOr otherwise degrades to a "parse failure" fallback). The
  // Qwen3.5 ladder models are "thinking" models: by default they emit a
  // chain-of-thought and can exhaust the token budget before producing the
  // required JSON (finish=length, content=null → parse failure every tick). Their
  // chat templates gate reasoning on an `enable_thinking` kwarg (default ON);
  // mlx_lm.server forwards `chat_template_kwargs` from the request body into the
  // template. This rides the existing `extraBody` plumbing — client.ts spreads
  // `...handle.params.extraBody` verbatim into the request body.
  //
  // Measured across 5 orient scenarios (blind-judged): thinking-ON produced
  // 3,640-16,384 tokens (41-213s); on the most complex scenario the monologue ran
  // to the 16,384 cap (finish=length) and never closed the JSON — a hard orient
  // failure. This mlx stack has NO constrained decoding, so no finite budget
  // guarantees against the runaway. Thinking-OFF produced valid JSON every run
  // (326-579 tokens, 4-7s) and was equal-or-better on 4 of 5 scenarios. The one
  // ON advantage (careful hedging on ambiguous inputs) is now recovered via the
  // orient prompt's epistemic-discipline instruction instead of the CoT monologue.
  //
  // Both structured-output tiers therefore DISABLE thinking:
  //   - hindbrain (`enable_thinking: false`) — observe is mechanical, no CoT gain.
  //   - forebrain (`enable_thinking: false`) — same decision after measurement;
  //     prompt-level discipline replaces the monologue for ambiguity handling.
  // The conscious tier (decide/evaluate) omits chat_template_kwargs entirely —
  // gemma-4-31b-it is an instruction model with no Qwen3.5-style enable_thinking
  // gate, so no kwarg is needed or meaningful.
  hindbrain: {
    tier: "hindbrain",
    provider: "mlx",
    baseUrl: "http://127.0.0.1:8081/v1",
    model: "mlx-community/Qwen3.5-2B-4bit",
    params: {
      temperature: 0.3,
      maxTokens: 4096,
      extraBody: { chat_template_kwargs: { enable_thinking: false } },
    },
  },
  // forebrain (orient) — like hindbrain, thinking is now DISABLED. Measured:
  // thinking-ON ran 41-213s and hit finish=length on complex inputs (no JSON
  // emitted). Thinking-OFF is ~10x faster (4-7s, 326-579 tokens) and equal-or-
  // better quality. maxTokens 1024 is ~1.8x the observed OFF maximum — ample
  // headroom at ~11s warm, well inside the 300s client timeout even at contended
  // 8 tok/s (~128s). Epistemic discipline (hedging on ambiguity) is enforced via
  // the orient prompt, not the CoT monologue.
  forebrain: {
    tier: "forebrain",
    provider: "mlx",
    baseUrl: "http://127.0.0.1:8082/v1",
    model: "mlx-community/Qwen3.5-9B-4bit",
    params: {
      temperature: 0.5,
      maxTokens: 1024,
      extraBody: { chat_template_kwargs: { enable_thinking: false } },
    },
  },
  // conscious (decide/evaluate) is the designated deep-thinker. gemma-4-31b-it
  // is a large instruction-tuned model — not a chain-of-thought reasoner like
  // the former Qwen3.5-122B-A10B — so isReasoningModel returns false for it.
  // The generous token budget gives headroom for multi-step decide/evaluate tasks.
  conscious: {
    tier: "conscious",
    provider: "mlx",
    baseUrl: "http://127.0.0.1:8083/v1",
    model: "mlx-community/gemma-4-31b-it-8bit",
    params: { temperature: 0.7, maxTokens: 16384 },
  },
}

/**
 * Whether a model id denotes a reasoning ("thinking") model — one that spends
 * its token budget on an internal chain-of-thought before emitting a final
 * answer. The structured-output tiers (hindbrain/forebrain) must NOT be backed
 * by such a model (Bug B: they hit finish=length with empty content).
 *
 * The conscious tier is the designated deep-thinker but is NOT required to be
 * a reasoning model. As of gemma-4-31b-it-8bit it is instruction-tuned (no
 * chain-of-thought regime), so isReasoningModel returns false for it.
 *
 * Classification is by name marker. Known reasoning families:
 *   - Qwen3.5-122B-A10B MoE (the ladder's reasoning member; dense siblings are not)
 *   - QwQ, DeepSeek-R1, Magistral, GLM-4.7-Flash
 *
 * This is only a classifier — it enforces nothing on its own. `mergeCortexModels`
 * applies overlays without consulting it, so an overlay can currently repoint a
 * structured tier at a reasoner. A future overlay-validator/guard could call this
 * to detect (and reject or warn about) such a repoint before it ships.
 */
export function isReasoningModel(model: string): boolean {
  const REASONING_MARKERS = [
    "A10B", // Qwen3.5-122B-A10B — the ladder's reasoning MoE
    "QwQ",
    "DeepSeek-R1",
    "Magistral",
    "GLM-4.7-Flash",
  ]
  return REASONING_MARKERS.some((m) => model.includes(m))
}

/** Look up the handle backing a cortex tier. */
export function resolveHandle(config: CortexModelConfig, tier: CortexTier): ModelHandle {
  return config[tier]
}

/** Merge a per-tier overlay onto a base config. Each tier is shallow-merged. */
export function mergeCortexModels(
  base: CortexModelConfig,
  overlay: CortexModelOverlay | undefined,
): CortexModelConfig {
  if (!overlay) return base
  const tiers: CortexTier[] = ["hindbrain", "forebrain", "conscious"]
  const out = {} as CortexModelConfig
  for (const tier of tiers) {
    out[tier] = overlay[tier] ? { ...base[tier], ...overlay[tier] } : base[tier]
  }
  return out
}
