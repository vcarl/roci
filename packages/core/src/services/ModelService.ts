import { Context, Effect, Layer, Scope } from "effect"
import type { CortexTier } from "../model/handles.js"
import type { ModelBackend, RunningServer } from "./model-backend.js"
import { SpawnError, ReadinessError } from "./model-backend.js"
import { MODEL_TIER_SPECS, resolveTierSpec, type TierSpec } from "./model-tier-spec.js"

export class ModelBackendTag extends Context.Tag("ModelBackend")<ModelBackendTag, ModelBackend>() {}

export class ModelService extends Context.Tag("ModelService")<
  ModelService,
  {
    readonly withTier: <A, E, R>(
      tier: CortexTier,
    ) => (effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | SpawnError | ReadinessError, R>
  }
>() {}

// Acquire one server (adopt if healthy, else spawn) into the AMBIENT scope, then
// probe it ready under the tier timeout. The acquireRelease registers a
// spawned-only kill finalizer on that scope, so closing the scope tears down
// exactly what we spawned and leaves adopted servers running.
const acquireReady = (
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
    yield* backend
      .readinessProbe(spec)
      .pipe(
        Effect.timeoutFail({
          duration: `${spec.timeoutMs} millis`,
          onTimeout: () =>
            new ReadinessError(spec.tier, spec.model, "readiness probe timed out", true),
        }),
      )
    return server
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
      <A, E, R>(tier: CortexTier) =>
      (effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | SpawnError | ReadinessError, R> => {
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
