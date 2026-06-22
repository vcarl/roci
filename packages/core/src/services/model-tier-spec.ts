import type { CortexTier } from "../model/handles.js"
import { DEFAULT_CORTEX_MODELS } from "../model/handles.js"

export type TierLifecycle = "resident" | "per-phase"

export interface TierSpec {
  readonly tier: CortexTier
  readonly model: string
  readonly port: number
  readonly baseUrl: string
  readonly spawnArgs: ReadonlyArray<string>
  readonly lifecycle: TierLifecycle
  readonly timeoutMs: number
}

// Port is the single source of truth: derive baseUrl from it and assert it
// matches the URL DEFAULT_CORTEX_MODELS already advertises for the tier, so
// ModelClient (which reads handle.baseUrl) and ModelService agree.
function specFor(
  tier: CortexTier,
  model: string,
  port: number,
  lifecycle: TierLifecycle,
  timeoutMs: number,
): TierSpec {
  const baseUrl = `http://127.0.0.1:${port}/v1`
  const advertised = DEFAULT_CORTEX_MODELS[tier].baseUrl
  if (advertised !== baseUrl) {
    throw new Error(
      `TierSpec port/baseUrl mismatch for ${tier}: spec=${baseUrl} handles=${advertised}`,
    )
  }
  return { tier, model, port, baseUrl, spawnArgs: [], lifecycle, timeoutMs }
}

// The 122B can lose the cold-load race for minutes; the light tiers load in
// seconds. Timeouts are generous headroom over observed cold-load times.
export const MODEL_TIER_SPECS: Readonly<Record<CortexTier, TierSpec>> = {
  hindbrain: specFor("hindbrain", "mlx-community/Qwen3.5-2B-4bit", 8081, "per-phase", 120_000),
  forebrain: specFor("forebrain", "mlx-community/Qwen3.5-9B-4bit", 8082, "per-phase", 180_000),
  conscious: specFor("conscious", "mlx-community/Qwen3.5-122B-A10B-4bit", 8083, "resident", 600_000),
}

export function resolveTierSpec(tier: CortexTier): TierSpec {
  return MODEL_TIER_SPECS[tier]
}
