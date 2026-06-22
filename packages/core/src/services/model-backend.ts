import type { Effect, Scope } from "effect"
import type { TierSpec } from "./model-tier-spec.js"

export class SpawnError {
  readonly _tag = "SpawnError"
  constructor(
    readonly tier: string,
    readonly model: string,
    readonly reason: string,
    readonly cause?: unknown,
  ) {}
  get message(): string {
    return `Model spawn failed [tier=${this.tier} model=${this.model}]: ${this.reason}`
  }
  toString(): string { return this.message }
}

export class ReadinessError {
  readonly _tag = "ReadinessError"
  constructor(
    readonly tier: string,
    readonly model: string,
    readonly reason: string,
    readonly timedOut: boolean,
    readonly cause?: unknown,
  ) {}
  get message(): string {
    return `Model readiness failed [tier=${this.tier} model=${this.model} timedOut=${this.timedOut}]: ${this.reason}`
  }
  toString(): string { return this.message }
}

export class ModelCrashed {
  readonly _tag = "ModelCrashed"
  constructor(
    readonly tier: string,
    readonly model: string,
    readonly reason: string,
    readonly cause?: unknown,
  ) {}
  get message(): string {
    return `Model crashed [tier=${this.tier} model=${this.model}]: ${this.reason}`
  }
  toString(): string { return this.message }
}

export interface RunningServer {
  readonly spec: TierSpec
  readonly spawned: boolean
  readonly pid: number | null
}

export interface ModelBackend {
  readonly spawn: (spec: TierSpec) => Effect.Effect<RunningServer, SpawnError, Scope.Scope>
  readonly readinessProbe: (spec: TierSpec) => Effect.Effect<void, ReadinessError>
  readonly kill: (server: RunningServer) => Effect.Effect<void>
  readonly isHealthy: (spec: TierSpec) => Effect.Effect<boolean>
}
