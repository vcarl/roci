import type { ModelProvider } from "../model/handles.js"
import type { ModelBackend } from "./model-backend.js"

// ---------------------------------------------------------------------------
// Composite ModelBackend: dispatch by the tier's serving provider.
//
// ModelService is provided ONE ModelBackend for all tiers, but the conscious tier
// now runs on llama.cpp while hindbrain/forebrain stay on mlx. This wrapper
// implements the ModelBackend interface by routing each call to the backend
// matching the relevant TierSpec's `provider`: methods that take a `spec` route
// on `spec.provider`; methods that take a `server` route on `server.spec.provider`
// (the spec is carried on the RunningServer, so a server always names its own
// provider). The underlying backends are unmodified — the readiness/kill contract
// is theirs; this only picks which one to talk to.

/**
 * Build a ModelBackend that dispatches every method to one of `byProvider` keyed
 * by the acting tier's provider. Callers supply a backend for each provider the
 * config can name; a spec whose provider has no entry throws (fail-fast — a
 * misconfigured provider must never silently no-op a spawn/kill).
 */
export function makeCompositeBackend(
  byProvider: Record<ModelProvider, ModelBackend>,
): ModelBackend {
  const pick = (provider: ModelProvider): ModelBackend => {
    const backend = byProvider[provider]
    if (!backend) {
      throw new Error(`No ModelBackend registered for provider "${provider}"`)
    }
    return backend
  }

  return {
    spawn: (spec) => pick(spec.provider).spawn(spec),
    readinessProbe: (spec) => pick(spec.provider).readinessProbe(spec),
    // Always present: dispatch to the target backend's server-bound probe when it
    // has one, else fall back to its spec-only probe (identical behavior, minus
    // the stderr tail). This keeps ModelService's `readinessProbeFor` fast-path
    // working across a mix of backends.
    readinessProbeFor: (server) => {
      const backend = pick(server.spec.provider)
      return backend.readinessProbeFor
        ? backend.readinessProbeFor(server)
        : backend.readinessProbe(server.spec)
    },
    kill: (server) => pick(server.spec.provider).kill(server),
    isHealthy: (spec) => pick(spec.provider).isHealthy(spec),
  }
}
