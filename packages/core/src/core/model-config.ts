import { modelRuntime, type AnyModel } from "./limbic/hypothalamus/runtime.js"
import { DEFAULT_CORTEX_MODELS } from "../model/handles.js"
import { consciousModelLabel } from "../conscious/opencode-config.js"

/** The three tiers a model role can resolve against. */
export type Tier = "fast" | "smart" | "reasoning"

/**
 * Roles that resolve to a model. `dreamCompression` — the unified per-cycle
 * reflection step that consolidates and then culls the diary/secrets (hippocampus
 * `dream.execute`); the former separate `dinner` (consolidate) role was collapsed
 * into it. retrospect (the per-cycle meso stage, spec §4) resolves to the smart
 * tier by default — no roles entry below — same as the dream reflection turn.
 * macro (the per-N-cycle growth-stimulation stage, spec §4) resolves to the
 * reasoning tier by default — the heaviest cognition of the three, distinct from
 * retrospect's smart tier. synthesisBootstrap (the one-time memory-index seed —
 * hippocampus/synthesis-bootstrap.ts; fires only when SYNTHESIS.md is absent/empty)
 * resolves to the smart tier by default — no roles entry below, same pattern as
 * retrospect: a bootstrap is a summarization task, lighter than macro's reasoning.
 * The former OODA/brain/scaffold/timeoutSummary roles were removed along with the
 * architectures that consumed them.
 */
export type Role = "dreamCompression" | "retrospect" | "macro" | "synthesisBootstrap"

export interface ModelConfig {
  tiers: Record<Tier, AnyModel>
  /** Per-role overrides — each either a tier name (resolved via `tiers`) or a raw model string. */
  roles?: Partial<Record<Role, AnyModel>>
}

/** The tier names, for tier-name-or-model-string resolution of role overrides. */
const TIER_NAMES: readonly Tier[] = ["fast", "smart", "reasoning"]

const isTierName = (s: string): s is Tier => (TIER_NAMES as readonly string[]).includes(s)

/** Default config: fast=haiku, smart=sonnet, reasoning=opus. */
export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  tiers: {
    fast: "haiku",
    smart: "sonnet",
    reasoning: "opus",
  },
  // The whole reflection dream step (consolidate + cull) runs on the local
  // conscious-tier mlx model (port 8083) via opencode. Derived from the conscious
  // handle (System A) so it is a single source of truth and can never drift from
  // the model the cortex actually serves.
  roles: {
    dreamCompression: consciousModelLabel(DEFAULT_CORTEX_MODELS.conscious),
  },
}

/**
 * Resolve a role to a concrete model string. A role override resolves as
 * TIER NAME or model string (the design contract): an override that exactly
 * matches a tier name ("fast" | "smart" | "reasoning") follows that tier's
 * model; any other string is used verbatim. No override → the supplied
 * default tier's model.
 */
export function resolveModel(
  config: ModelConfig,
  role: Role,
  defaultTier: Tier,
): AnyModel {
  const override = config.roles?.[role]
  if (override === undefined) return config.tiers[defaultTier]
  return isTierName(override) ? config.tiers[override] : override
}

/** Raised when a model config contains a string that resolves to no known runtime. */
export class ModelConfigError {
  readonly _tag = "ModelConfigError"
  constructor(readonly message: string) {}
  toString() {
    return `ModelConfigError: ${this.message}`
  }
}

/** Every dispatchable model string in a config, tagged with the key it came from. */
function configModelEntries(config: ModelConfig): Array<{ key: string; model: AnyModel }> {
  const entries: Array<{ key: string; model: AnyModel }> = []
  for (const tier of ["fast", "smart", "reasoning"] as const) {
    entries.push({ key: `tiers.${tier}`, model: config.tiers[tier] })
  }
  for (const [role, model] of Object.entries(config.roles ?? {})) {
    // An `undefined` override is a no-op (the role falls back to its tier), so it
    // needs no runtime. A TIER-NAME override is legal indirection (resolveModel
    // follows it to config.tiers[tier]); what it resolves to is already validated
    // via the tier entries above — so a tier-name override pointing at a broken
    // tier value fails on `tiers.<tier>`, not on the role. Skip both.
    if (model !== undefined && !isTierName(model)) {
      entries.push({ key: `roles.${role}`, model })
    }
  }
  return entries
}

/**
 * Validate that every tier and per-role override resolves to a known runtime via
 * the single source of truth (`modelRuntime`). Throws {@link ModelConfigError}
 * naming each offending key + its value and the accepted forms. This is the
 * load-time gate that makes runtime dispatch total: a config that passes here can
 * never silently misroute a turn to the wrong runtime. Call it once, right after
 * merging defaults / file / CLI overrides.
 */
export function assertValidModelConfig(config: ModelConfig): void {
  const bad = configModelEntries(config).filter(
    ({ model }) => modelRuntime(model) === undefined,
  )
  if (bad.length === 0) return
  const lines = bad.map(({ key, model }) => `  ${key} = ${JSON.stringify(model)}`)
  throw new ModelConfigError(
    `Unrecognized model(s) — each tier/role must be a Claude alias ` +
      `(opus | sonnet | haiku), a fully-qualified claude-* id (e.g. claude-opus-4-6), ` +
      `or a provider/model string (e.g. local/mlx-community/gemma-4-31b-it-8bit); ` +
      `a role may also name a tier (fast | smart | reasoning):\n` +
      lines.join("\n"),
  )
}
