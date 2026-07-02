import type { AnyModel } from "./limbic/hypothalamus/runtime.js"
import { DEFAULT_CORTEX_MODELS } from "../model/handles.js"
import { consciousModelLabel } from "../conscious/opencode-config.js"

/** The three tiers a model role can resolve against. */
export type Tier = "fast" | "smart" | "reasoning"

/**
 * Roles that resolve to a model. Only the two live memory-pass roles remain
 * (dreamCompression — the dream/cull; dinner — the per-cycle consolidate). The
 * former OODA/brain/scaffold/timeoutSummary roles were removed along with the
 * architectures that consumed them.
 */
export type Role = "dreamCompression" | "dinner"

export interface ModelConfig {
  tiers: Record<Tier, AnyModel>
  /** Per-role overrides, each a raw model string. */
  roles?: Partial<Record<Role, AnyModel>>
}

/** Default config: fast=haiku, smart=sonnet, reasoning=opus. */
export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  tiers: {
    fast: "haiku",
    smart: "sonnet",
    reasoning: "opus",
  },
  // Memory compression runs on the local conscious-tier mlx model (port 8083)
  // via opencode. Derived from the conscious handle (System A) so it is a single
  // source of truth and can never drift from the model the cortex actually serves.
  roles: {
    dreamCompression: consciousModelLabel(DEFAULT_CORTEX_MODELS.conscious),
  },
}

/**
 * Resolve a role to a concrete model string: the role override if present,
 * otherwise the supplied default tier's model.
 */
export function resolveModel(
  config: ModelConfig,
  role: Role,
  defaultTier: Tier,
): AnyModel {
  return config.roles?.[role] ?? config.tiers[defaultTier]
}
