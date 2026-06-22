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
   * (e.g. `response_format`, or llama.cpp's `grammar`/`json_schema`).
   * Used by Plan 2 for grammar-constrained decoding.
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
  // every tick. Reasoning models burn the token budget on a variable
  // chain-of-thought and intermittently hit finish=length with empty content
  // (Bug B on hindbrain; the same failure was directly observed on forebrain's
  // GLM-4.7-Flash — 2/6 orient probes truncated). Instruct models emit the JSON
  // directly (reasoningLen=0, finish=stop), so the structured-output tiers are
  // pinned to instruct models. The maxTokens budget stays generous as headroom.
  hindbrain: {
    tier: "hindbrain",
    provider: "mlx",
    baseUrl: "http://127.0.0.1:8081/v1",
    model: "mlx-community/Qwen3.5-2B-4bit",
    params: { temperature: 0.3, maxTokens: 4096 },
  },
  forebrain: {
    tier: "forebrain",
    provider: "mlx",
    baseUrl: "http://127.0.0.1:8082/v1",
    model: "mlx-community/Qwen3.5-9B-4bit",
    params: { temperature: 0.5, maxTokens: 4096 },
  },
  // conscious (decide/evaluate) is the designated deep-reasoner: a reasoning
  // model is appropriate here, and its larger 8192 budget + smaller output
  // schema have held up in practice. The 122B-A10B MoE is the reasoning tier
  // (see isReasoningModel); the dense 2B/9B siblings are not.
  conscious: {
    tier: "conscious",
    provider: "mlx",
    baseUrl: "http://127.0.0.1:8083/v1",
    model: "mlx-community/Qwen3.5-122B-A10B-4bit",
    params: { temperature: 0.7, maxTokens: 8192 },
  },
}

/**
 * Whether a model id denotes a reasoning ("thinking") model — one that spends
 * its token budget on an internal chain-of-thought before emitting a final
 * answer. The structured-output tiers (hindbrain/forebrain) must NOT be backed
 * by such a model (Bug B: they hit finish=length with empty content); the
 * conscious tier is deliberately the deep-reasoner.
 *
 * Classification is by name marker. Within the Qwen3.5 ladder the reasoning
 * member is the large 122B-A10B MoE; the dense small siblings (2B / 9B) are
 * plain generators. Known reasoning families outside the ladder are listed too.
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
