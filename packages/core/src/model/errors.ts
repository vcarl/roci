import type { CortexTier } from "./handles.js"

export interface ModelErrorFields {
  tier: CortexTier
  model: string
  baseUrl: string
  reason: string
  cause?: unknown
}

/**
 * A model call failed. Fail-fast and descriptive: a missing/unreachable local
 * model is a config/ops error, surfaced loudly — there is no automatic failover.
 */
export class ModelError {
  readonly _tag = "ModelError"
  readonly tier: CortexTier
  readonly model: string
  readonly baseUrl: string
  readonly reason: string
  readonly cause?: unknown

  constructor(fields: ModelErrorFields) {
    this.tier = fields.tier
    this.model = fields.model
    this.baseUrl = fields.baseUrl
    this.reason = fields.reason
    this.cause = fields.cause
  }

  get message(): string {
    return `Model call failed [tier=${this.tier} model=${this.model} endpoint=${this.baseUrl}]: ${this.reason}`
  }

  toString(): string {
    return this.message
  }
}
