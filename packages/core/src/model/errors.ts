import type { CortexTier } from "./handles.js"

export interface ModelErrorFields {
  tier: CortexTier
  model: string
  baseUrl: string
  reason: string
  cause?: unknown
  /**
   * Whether this failure is transient and worth retrying (network error,
   * timeout/abort, HTTP 5xx, 429). Genuine model/config errors (malformed
   * content, invalid JSON, 4xx auth/bad-request) are NOT retryable and default
   * to `false`. The transport retry policy classifies on this flag alone, so it
   * never masks a genuine error or loops on an unrecoverable one.
   */
  retryable?: boolean
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
  readonly retryable: boolean

  constructor(fields: ModelErrorFields) {
    this.tier = fields.tier
    this.model = fields.model
    this.baseUrl = fields.baseUrl
    this.reason = fields.reason
    this.cause = fields.cause
    this.retryable = fields.retryable ?? false
  }

  get message(): string {
    return `Model call failed [tier=${this.tier} model=${this.model} endpoint=${this.baseUrl}]: ${this.reason}`
  }

  toString(): string {
    return this.message
  }
}
