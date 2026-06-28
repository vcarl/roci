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

// handles (DEFAULT_CORTEX_MODELS) is the single source of truth for which model
// answers each tier and where. The spec DERIVES model + baseUrl from the handle
// so the server we spawn can never serve a model/endpoint the cortex doesn't
// call. specFor only carries spawn-only metadata (port, lifecycle, timeout) that
// handles doesn't model; the port is cross-checked against the handle's baseUrl
// so the two can't drift on the endpoint either.
function specFor(
  tier: CortexTier,
  port: number,
  lifecycle: TierLifecycle,
  timeoutMs: number,
): TierSpec {
  const handle = DEFAULT_CORTEX_MODELS[tier]
  const baseUrl = handle.baseUrl
  const fromPort = `http://127.0.0.1:${port}/v1`
  if (baseUrl !== fromPort) {
    throw new Error(
      `TierSpec port/baseUrl mismatch for ${tier}: spec port=${port} (${fromPort}) handles=${baseUrl}`,
    )
  }
  return { tier, model: handle.model, port, baseUrl, spawnArgs: [], lifecycle, timeoutMs }
}

// The conscious tier (gemma-4-31b) can lose the cold-load race for minutes;
// the light tiers load in seconds. Timeouts are generous headroom over observed cold-load times.
export const MODEL_TIER_SPECS: Readonly<Record<CortexTier, TierSpec>> = {
  hindbrain: specFor("hindbrain", 8081, "per-phase", 120_000),
  forebrain: specFor("forebrain", 8082, "per-phase", 180_000),
  conscious: specFor("conscious", 8083, "resident", 600_000),
}

export function resolveTierSpec(tier: CortexTier): TierSpec {
  return MODEL_TIER_SPECS[tier]
}
