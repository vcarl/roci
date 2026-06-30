import { Effect, Ref } from "effect"
import type { TierSpec } from "./model-tier-spec.js"
import type { ModelBackend, RunningServer } from "./model-backend.js"
import { ReadinessError } from "./model-backend.js"

export interface FakeScript {
  readonly spawnDelayMs?: Partial<Record<string, number>>
  readonly probe?: Partial<Record<string, "ready" | "fail" | "timeout">>
  readonly probeDelayMs?: Partial<Record<string, number>>
  // Simulate a COLD load: the first N readiness probes for the tier FAIL
  // (server not bound / weights not loaded yet), then every subsequent probe
  // SUCCEEDS. Models the real mlx cold-start where the gate must poll, not
  // single-shot. Takes precedence over `probe` for the listed tier.
  readonly probeFailFirst?: Partial<Record<string, number>>
  // Simulate a server that SPAWNS but NEVER becomes ready within its budget for
  // the first N spawn generations: the first N readiness probes for the tier
  // hang "forever" (so the gate's per-attempt timeoutMs elapses → a timed-out
  // ReadinessError), then every subsequent probe SUCCEEDS. Unlike
  // `probeFailFirst` (a fast failure consumed by the in-attempt cold-load poll),
  // a hanging probe forces the WHOLE attempt to time out — the condition that
  // drives a server RESTART. Set it large (e.g. 1_000_000) to model a server
  // that never recovers. Takes precedence over `probe` for the listed tier.
  readonly probeTimeoutFirst?: Partial<Record<string, number>>
  readonly healthy?: ReadonlyArray<string>
}
export interface FakeBackendLog {
  readonly spawns: ReadonlyArray<string>
  readonly kills: ReadonlyArray<string>
  readonly probes: ReadonlyArray<string>
  readonly healthChecks: ReadonlyArray<string>
}
export interface FakeBackend extends ModelBackend {
  readonly log: () => Effect.Effect<FakeBackendLog>
}

interface MutLog {
  spawns: string[]
  kills: string[]
  probes: string[]
  healthChecks: string[]
}

export function makeFakeBackend(script: FakeScript = {}): Effect.Effect<FakeBackend> {
  return Effect.gen(function* () {
    const logRef = yield* Ref.make<MutLog>({ spawns: [], kills: [], probes: [], healthChecks: [] })
    // Per-tier count of probes already issued, to drive `probeFailFirst`.
    const probeCountRef = yield* Ref.make<Record<string, number>>({})
    let nextPid = 1000

    const spawn = (spec: TierSpec): Effect.Effect<RunningServer, never> =>
      Effect.gen(function* () {
        const delay = script.spawnDelayMs?.[spec.tier] ?? 0
        if (delay > 0) yield* Effect.sleep(`${delay} millis`)
        yield* Ref.update(logRef, (l) => ({ ...l, spawns: [...l.spawns, spec.tier] }))
        return { spec, spawned: true, pid: nextPid++ }
      })

    const readinessProbe = (spec: TierSpec): Effect.Effect<void, ReadinessError> =>
      Effect.gen(function* () {
        yield* Ref.update(logRef, (l) => ({ ...l, probes: [...l.probes, spec.tier] }))
        // Cold-load simulation: fail the first N probes, then succeed. The
        // count is incremented per probe call so a polling gate eventually
        // sees a success; a single-shot gate fails on the very first probe.
        const timeoutFirst = script.probeTimeoutFirst?.[spec.tier]
        if (timeoutFirst != null) {
          const seen = yield* Ref.modify(probeCountRef, (m) => {
            const n = (m[spec.tier] ?? 0) + 1
            return [n, { ...m, [spec.tier]: n }]
          })
          if (seen <= timeoutFirst) {
            // Hang past any sane timeoutMs; the gate's per-attempt timeoutFail
            // interrupts this sleep and yields a timed-out ReadinessError.
            yield* Effect.sleep("10000000 millis")
          }
          return
        }
        const failFirst = script.probeFailFirst?.[spec.tier]
        if (failFirst != null) {
          const seen = yield* Ref.modify(probeCountRef, (m) => {
            const n = (m[spec.tier] ?? 0) + 1
            return [n, { ...m, [spec.tier]: n }]
          })
          if (seen <= failFirst) {
            return yield* Effect.fail(
              new ReadinessError(spec.tier, spec.model, "scripted cold-load probe failure", false),
            )
          }
          return
        }
        const outcome = script.probe?.[spec.tier] ?? "ready"
        const probeDelay = script.probeDelayMs?.[spec.tier] ?? 0
        if (outcome === "fail") {
          return yield* Effect.fail(
            new ReadinessError(spec.tier, spec.model, "scripted probe failure", false),
          )
        }
        if (outcome === "timeout") {
          // Sleep "forever" relative to any sane timeoutMs; the caller wraps
          // with Effect.timeout and a TestClock advance triggers the timeout.
          yield* Effect.sleep(`${probeDelay > 0 ? probeDelay : 10_000_000} millis`)
          return
        }
        if (probeDelay > 0) yield* Effect.sleep(`${probeDelay} millis`)
      })

    const kill = (server: RunningServer): Effect.Effect<void> =>
      Ref.update(logRef, (l) => ({ ...l, kills: [...l.kills, server.spec.tier] }))

    const isHealthy = (spec: TierSpec): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        yield* Ref.update(logRef, (l) => ({ ...l, healthChecks: [...l.healthChecks, spec.tier] }))
        return (script.healthy ?? []).includes(spec.tier)
      })

    const log = (): Effect.Effect<FakeBackendLog> =>
      Ref.get(logRef).pipe(Effect.map((l) => ({
        spawns: [...l.spawns],
        kills: [...l.kills],
        probes: [...l.probes],
        healthChecks: [...l.healthChecks],
      })))

    return { spawn, readinessProbe, kill, isHealthy, log }
  })
}
