import { Context, Effect, Exit, ExecutionStrategy, Layer, Schedule, Scope } from "effect"
import type { CortexTier } from "../model/handles.js"
import type { ModelBackend, RunningServer } from "./model-backend.js"
import { SpawnError, ReadinessError } from "./model-backend.js"
import { MODEL_TIER_SPECS, resolveTierSpec, type TierSpec } from "./model-tier-spec.js"

export class ModelBackendTag extends Context.Tag("ModelBackend")<ModelBackendTag, ModelBackend>() {}

export class ModelService extends Context.Tag("ModelService")<
  ModelService,
  {
    readonly withTier: (
      tier: CortexTier,
    ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | SpawnError | ReadinessError, R>
  }
>() {}

// Readiness-restart policy. When a single acquire+probe attempt fails (spawn
// error, or the per-tier readiness budget elapses), we TEAR DOWN that attempt's
// stale/half-spawned server and try again with a fresh process, backing off
// exponentially. RESTART_MAX_RETRIES is the number of RESTARTS after the initial
// attempt, so the gate makes up to (1 + RESTART_MAX_RETRIES) readiness attempts
// before surfacing the failure. Delay before restart N (1-based) is
// RESTART_BASE_DELAY_MS * 2^(N-1) → 1s, 2s, 4s, 8s, … (no cap; see the cumulative
// caveat in the restart loop).
export const RESTART_MAX_RETRIES = 10
export const RESTART_BASE_DELAY_MS = 1_000

// ONE acquire+probe attempt: adopt-if-healthy, else spawn into the AMBIENT scope,
// then probe ready under the tier timeout. The acquireRelease registers a
// spawned-only kill finalizer on that scope, so closing the scope tears down
// exactly what we spawned and leaves adopted servers running. `acquireReady`
// drives this once per restart against a fresh per-attempt scope.
const attemptReady = (
  backend: ModelBackend,
  spec: TierSpec,
): Effect.Effect<RunningServer, SpawnError | ReadinessError, Scope.Scope> =>
  Effect.gen(function* () {
    const healthy = yield* backend.isHealthy(spec)
    const server: RunningServer = healthy
      ? { spec, spawned: false, pid: null }
      : yield* Effect.acquireRelease(
          backend.spawn(spec),
          (srv) => (srv.spawned ? backend.kill(srv) : Effect.void),
        )
    // A real cold load can take seconds → minutes for the server to bind and
    // load weights; a single probe fails in milliseconds. POLL: re-probe on a
    // fixed interval until success, bounded by the per-tier timeoutMs. The
    // first probe runs at t=0; spaced retries follow. timeoutFail interrupts
    // the retry loop and fails with timedOut=true when the budget elapses.
    // 1s spacing: cheap relative to the multi-second cold loads and the
    // generous (120s–600s) budgets, while keeping the gate responsive.
    // Prefer the server-bound probe so a never-ready/dead spawned server names
    // its own recent stderr in the ReadinessError. Adopted servers (no
    // stderrTail) and backends without readinessProbeFor fall back to the
    // spec-only probe — behavior is otherwise identical.
    const probe =
      backend.readinessProbeFor !== undefined && server.spawned
        ? backend.readinessProbeFor(server)
        : backend.readinessProbe(spec)
    yield* probe
      .pipe(
        Effect.retry(Schedule.spaced("1 second")),
        Effect.timeoutFail({
          duration: `${spec.timeoutMs} millis`,
          onTimeout: () =>
            new ReadinessError(spec.tier, spec.model, "readiness probe timed out", true),
        }),
      )
    return server
  })

// Acquire a ready server for `spec`, RESTARTING on failure with exponential
// backoff. Each attempt runs `attemptReady` in its OWN child scope forked from
// the ambient scope:
//   • success → the child scope is left open, so it (and its spawned-only kill
//     finalizer) is owned by the ambient scope exactly like before — resident
//     tiers stay held for the session; per-phase tiers are killed when their
//     transient scope closes.
//   • failure → we CLOSE that child scope immediately, running the kill
//     finalizer NOW. This tears down the stale/half-spawned process for THIS
//     tier (targeted by spec → tier+port+model) before the next attempt, so a
//     wedged or zombie server is reaped and never accumulates or holds the port.
//     Adopted (healthy, externally-started) servers register no kill finalizer,
//     so closing the child is a no-op for them — we never kill a server we
//     didn't spawn; a later attempt simply re-checks health and may spawn fresh.
// After RESTART_MAX_RETRIES restarts are exhausted we re-raise the LAST failure's
// cause, preserving the existing terminal behavior (e.g. ReadinessError with
// timedOut=true and the server's stderr tail).
//
// Caveat: delays are uncapped exponential (1s…512s on the 10th restart), so a
// server that never recovers blocks for ~2300s of timeouts+backoff before the
// terminal failure. That is the explicit "10 doubling retries" policy; tune the
// constants above if a ceiling is wanted.
export const acquireReady = (
  backend: ModelBackend,
  spec: TierSpec,
): Effect.Effect<RunningServer, SpawnError | ReadinessError, Scope.Scope> =>
  Effect.gen(function* () {
    const parent = yield* Effect.scope
    for (let attempt = 0; ; attempt++) {
      // Fork a child of the ambient scope: closing the parent closes this child,
      // so a SUCCESSFUL attempt's server is torn down with the parent (unchanged
      // resident/per-phase lifetime). A FAILED attempt we close ourselves below.
      const child = yield* Scope.fork(parent, ExecutionStrategy.sequential)
      const result = yield* attemptReady(backend, spec).pipe(Scope.extend(child), Effect.exit)
      if (Exit.isSuccess(result)) {
        return result.value
      }
      // Tear down this attempt's spawned process before retrying (no port/proc
      // leak across restarts). Closing with the failure exit runs the kill
      // finalizer; for an adopted server there is no finalizer → harmless no-op.
      yield* Scope.close(child, result)
      if (attempt >= RESTART_MAX_RETRIES) {
        // Exhausted: re-raise the last failure exactly (preserves ReadinessError
        // timedOut + stderr tail). Yielding a failed Exit re-fails the effect.
        return yield* result
      }
      const delayMs = RESTART_BASE_DELAY_MS * 2 ** attempt
      yield* Effect.logWarning(
        `model readiness failed; restarting server [tier=${spec.tier} model=${spec.model} ` +
          `port=${spec.port}] restart ${attempt + 1}/${RESTART_MAX_RETRIES} in ${delayMs}ms`,
      )
      yield* Effect.sleep(`${delayMs} millis`)
    }
  })

export function makeModelService(
  backend: ModelBackend,
): Effect.Effect<ModelService["Type"], SpawnError | ReadinessError, Scope.Scope> {
  return Effect.gen(function* () {
    // 1. Resident tiers first, in deterministic order, gated on readiness.
    //    The resident conscious is acquired into the AMBIENT (layer) scope and
    //    held for the whole session.
    const residents = (Object.keys(MODEL_TIER_SPECS) as CortexTier[])
      .map((t) => MODEL_TIER_SPECS[t])
      .filter((s) => s.lifecycle === "resident")
    // conscious before any other; sort by port ascending is irrelevant here
    // (only conscious is resident), but keep deterministic:
    residents.sort((a, b) => a.tier.localeCompare(b.tier))
    for (const spec of residents) {
      yield* acquireReady(backend, spec)
    }

    // 2. Startup gate for the per-phase tiers: the spec requires all three tiers
    //    to be validated AT STARTUP, so a required-tier readiness failure fails
    //    the whole layer before the service becomes available. We validate each
    //    per-phase tier once and release it immediately (transient): adopt if
    //    healthy (no spawn, no kill), else spawn → probe → kill, reusing the same
    //    acquireReady primitive the runtime per-phase path uses. The kill happens
    //    when the transient inner scope closes — these tiers are NOT held; they
    //    are spawned again per-phase at runtime (unchanged runtime behavior). A
    //    probe failure on ANY tier propagates out and fails the layer build.
    const perPhase = (Object.keys(MODEL_TIER_SPECS) as CortexTier[])
      .map((t) => MODEL_TIER_SPECS[t])
      .filter((s) => s.lifecycle === "per-phase")
    perPhase.sort((a, b) => a.tier.localeCompare(b.tier))
    for (const spec of perPhase) {
      // fresh inner scope → acquire+probe, then release (spawned-only kill) on
      // close. Failure here propagates and fails makeModelService / the layer.
      yield* Effect.scoped(acquireReady(backend, spec))
    }

    const withTier =
      (tier: CortexTier) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | SpawnError | ReadinessError, R> => {
        const spec = resolveTierSpec(tier)
        if (spec.lifecycle === "resident") {
          return effect as Effect.Effect<A, E | SpawnError | ReadinessError, R>
        }
        // per-phase: fresh inner scope; release (kill) guaranteed on close.
        return Effect.scoped(
          Effect.gen(function* () {
            yield* acquireReady(backend, spec)
            return yield* effect
          }),
        )
      }

    return { withTier }
  })
}

export const ModelServiceLive: Layer.Layer<
  ModelService,
  SpawnError | ReadinessError,
  ModelBackendTag
> = Layer.scoped(
  ModelService,
  Effect.gen(function* () {
    const backend = yield* ModelBackendTag
    return yield* makeModelService(backend)
  }),
)
