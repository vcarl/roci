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
  toString(): string { return `ReadinessError: ${this.message}` }
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
  /**
   * The most recent stderr lines captured from a spawned server, joined by
   * newlines. Present only for servers we spawned (an adopted/healthy server's
   * stderr is owned by whoever started it). Best-effort diagnostics: used to
   * enrich a SpawnError/ReadinessError after a death or never-ready.
   */
  readonly stderrTail?: () => Effect.Effect<string>
  /**
   * Completes when the spawned process has exited. Present only for servers we
   * spawned (an adopted server's lifecycle is owned elsewhere). The `kill`
   * finalizer races this against a bounded grace after SIGTERM so it can return
   * immediately when the server reaps promptly, and only escalates to SIGKILL
   * when it observes the process is still alive after the grace. Never fails:
   * any error observing exit is normalized to "it exited" (best-effort liveness).
   */
  readonly awaitExit?: Effect.Effect<void>
}

export interface ModelBackend {
  readonly spawn: (spec: TierSpec) => Effect.Effect<RunningServer, SpawnError, Scope.Scope>
  readonly readinessProbe: (spec: TierSpec) => Effect.Effect<void, ReadinessError>
  /**
   * Server-bound readiness probe. Identical to `readinessProbe`, but a failure
   * carries the spawned server's recent stderr tail so a never-ready/dead server
   * is diagnosable. Optional: backends that don't capture stderr (e.g. the fake)
   * can omit it, and callers fall back to `readinessProbe`.
   */
  readonly readinessProbeFor?: (server: RunningServer) => Effect.Effect<void, ReadinessError>
  readonly kill: (server: RunningServer) => Effect.Effect<void>
  readonly isHealthy: (spec: TierSpec) => Effect.Effect<boolean>
}
