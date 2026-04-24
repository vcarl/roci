import type { AnyModel } from "./limbic/hypothalamus/runtime.js"

/** The three tiers users can configure. */
export type Tier = "fast" | "smart" | "reasoning"

/**
 * Roles that resolve to a model. Each role has a default tier;
 * users may override per-role with a tier name or a raw model string.
 */
export type Role =
  | "brainPlan"
  | "brainInterrupt"
  | "brainEvaluate"
  | "diarySubagent"
  | "dreamCompression"
  | "dinner"
  | "timeoutSummary"
  | "scaffoldIdentity"
  | "scaffoldSummary"
  | "oodaObserve"
  | "oodaOrient"
  | "oodaDecide"
  | "oodaEvaluate"

export interface ModelConfig {
  tiers: Record<Tier, AnyModel>
  /** Per-role overrides. Each value is either a tier name or a raw model string. */
  roles?: Partial<Record<Role, Tier | AnyModel>>
}

/** A partial overlay used by the merge helper (file or CLI). */
export interface ModelConfigOverlay {
  tiers?: Partial<Record<Tier, AnyModel>>
  roles?: Partial<Record<Role, Tier | AnyModel>>
}

/** Default config: fast=haiku, smart=sonnet, reasoning=opus, no role overrides. */
export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  tiers: {
    fast: "haiku",
    smart: "sonnet",
    reasoning: "opus",
  },
}

const TIER_NAMES = new Set<string>(["fast", "smart", "reasoning"])

export function isTier(value: string): value is Tier {
  return TIER_NAMES.has(value)
}

/**
 * Resolve a role to a concrete model string.
 * Order of precedence:
 *   1. Role override (tier name → tier value, OR raw model string passed through)
 *   2. The supplied default tier
 */
export function resolveModel(
  config: ModelConfig,
  role: Role,
  defaultTier: Tier,
): AnyModel {
  const override = config.roles?.[role]
  if (override !== undefined) {
    if (typeof override === "string" && isTier(override)) {
      return config.tiers[override]
    }
    return override
  }
  return config.tiers[defaultTier]
}

/**
 * Merge an overlay (e.g. user file or CLI flags) onto a base config.
 * Tier values are overlaid key-by-key. Roles are merged additively.
 */
export function mergeModelConfig(
  base: ModelConfig,
  overlay: ModelConfigOverlay | undefined,
): ModelConfig {
  if (!overlay) return base
  return {
    tiers: { ...base.tiers, ...(overlay.tiers ?? {}) },
    roles: { ...(base.roles ?? {}), ...(overlay.roles ?? {}) },
  }
}
