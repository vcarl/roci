import { describe, it, expect } from "vitest"
import { Cause, Effect, Exit, Fiber, Option, TestClock, TestContext } from "effect"
import { makeFakeBackend } from "./model-backend-fake.js"
import { makeModelService, ModelService } from "./ModelService.js"
import { ReadinessError } from "./model-backend.js"
import { resolveTierSpec } from "./model-tier-spec.js"

// Run a scoped program against a fake backend. The service is built inside the
// same scope so its resident-acquire + teardown are exercised.
type FakeLog = { spawns: ReadonlyArray<string>; kills: ReadonlyArray<string>; probes: ReadonlyArray<string>; healthChecks: ReadonlyArray<string> }
const withService = <A, E>(
  script: Parameters<typeof makeFakeBackend>[0],
  use: (svc: ModelService["Type"], log: () => Effect.Effect<FakeLog>) => Effect.Effect<A, E, never>,
) =>
  Effect.gen(function* () {
    const be = yield* makeFakeBackend(script)
    const svc = yield* makeModelService(be)
    return yield* use(svc, be.log)
  }).pipe(Effect.scoped)

describe("ModelService — resident-first gating", () => {
  it("acquires + probes the resident conscious tier before the service is usable", async () => {
    const out = await Effect.runPromise(
      withService({}, (_svc, log) => log()),
    )
    // conscious is acquired FIRST (resident loop runs before the per-phase
    // startup gate), then the per-phase tiers are validated-and-released.
    expect(out.spawns[0]).toBe("conscious")
    expect(out.probes).toContain("conscious")
  })

  it("kills the spawned resident tier when the scope closes", async () => {
    // Capture the backend's log fn in a closure that OUTLIVES Effect.scoped, so
    // we can read the kill log AFTER the scope (and its finalizers) have closed.
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        let readLog: (() => Effect.Effect<{
          spawns: ReadonlyArray<string>
          kills: ReadonlyArray<string>
          probes: ReadonlyArray<string>
          healthChecks: ReadonlyArray<string>
        }>) | null = null
        // open-and-close the scope: build the service (acquires conscious) and
        // capture log + a snapshot taken while still inside the scope.
        const inside = yield* Effect.gen(function* () {
          const be = yield* makeFakeBackend({})
          yield* makeModelService(be)
          readLog = be.log
          return yield* be.log()
        }).pipe(Effect.scoped)
        // scope has now closed → finalizers (spawned-only kill) have run.
        const after = yield* readLog!()
        return { inside, after }
      }),
    )
    // conscious (resident) spawned first and NOT killed while the scope was open.
    // (The per-phase startup gate also spawns+kills hindbrain/forebrain
    // transiently; we only assert on the resident tier here.)
    expect(out.inside.spawns[0]).toBe("conscious")
    expect(out.inside.kills).not.toContain("conscious")
    // …and conscious is killed once the scope closed.
    expect(out.after.kills).toContain("conscious")
  })
})

describe("ModelService — required-tier readiness timeout fails the layer", () => {
  it("a resident probe that never returns fails makeModelService after exhausting restarts", async () => {
    // Deterministic: drive the conscious readiness timeout (600_000ms) with
    // TestClock so no wall-clock time elapses. A never-ready server now RESTARTS
    // up to 10 times (1 + 10 attempts × 600s timeout + ~1023s exponential
    // backoff ≈ 7623s) before the layer build finally fails. Advance past the
    // whole restart budget, then await the fiber's Exit.
    const program = Effect.gen(function* () {
      const be = yield* makeFakeBackend({ probe: { conscious: "timeout" } })
      return yield* makeModelService(be)
    }).pipe(Effect.scoped)
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(program)
        yield* TestClock.adjust("7700000 millis")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestContext.TestContext)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe("ModelService — readiness gate POLLS across a cold load", () => {
  it("succeeds by polling a backend that fails its first K probes then becomes ready", async () => {
    // Real cold load: the server isn't 200 for the first several probes, then
    // binds. The gate MUST keep probing (bounded by timeoutMs), not single-shot.
    // We script conscious (resident, 600_000ms budget) to fail its first 5
    // probes; with ~1s spacing the gate needs ~5s of (virtual) time. Drive it
    // with TestClock so no wall-time passes.
    const program = Effect.gen(function* () {
      const be = yield* makeFakeBackend({ probeFailFirst: { conscious: 5 } })
      yield* makeModelService(be)
      return yield* be.log()
    }).pipe(Effect.scoped)
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(program)
        // advance well past 5 spaced retries but well under the 600_000 budget.
        yield* TestClock.adjust("30000 millis")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestContext.TestContext)),
    )
    // conscious was probed MORE than once (the gate polled across the cold load)
    // and the service built successfully (we got the log back).
    expect(out.probes.filter((t) => t === "conscious").length).toBeGreaterThan(1)
    expect(out.spawns[0]).toBe("conscious")
  })

  it("fails with ReadinessError(timedOut=true) when the backend never becomes ready before the budget elapses", async () => {
    // hindbrain (per-phase, 120_000ms budget) is scripted to fail an effectively
    // unbounded number of probes. Each budget that elapses triggers a RESTART;
    // once all 10 restarts are exhausted (≈ 11 × 120s + ~1023s backoff ≈ 2343s)
    // the gate gives up with a timed-out ReadinessError that fails the layer.
    const program = Effect.gen(function* () {
      const be = yield* makeFakeBackend({ probeTimeoutFirst: { hindbrain: 1_000_000 } })
      return yield* makeModelService(be)
    }).pipe(Effect.scoped)
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(program)
        yield* TestClock.adjust("2400000 millis")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestContext.TestContext)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const err = exit._tag === "Failure" ? Cause.failureOption(exit.cause) : Option.none()
    expect(Option.isSome(err)).toBe(true)
    const e = (err as Extract<typeof err, { _tag: "Some" }>).value
    expect(e).toBeInstanceOf(ReadinessError)
    expect((e as ReadinessError).timedOut).toBe(true)
  })
})

describe("ModelService — all three tiers required at startup", () => {
  it("fails the layer build when a per-phase tier (hindbrain) never passes its startup probe", async () => {
    // The startup gate probes every per-phase tier. A hindbrain that NEVER
    // becomes ready must fail makeModelService (the layer build), even though
    // the resident conscious is healthy. With the polling+restart gate this is a
    // timeout repeated across 10 restarts: each 120_000ms budget elapses, the
    // server is restarted, and only after the budget is exhausted (≈ 2343s) does
    // the layer build fail. Drive past the whole restart budget with TestClock.
    const program = Effect.gen(function* () {
      const be = yield* makeFakeBackend({ probeTimeoutFirst: { hindbrain: 1_000_000 } })
      return yield* makeModelService(be)
    }).pipe(Effect.scoped)
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(program)
        yield* TestClock.adjust("2400000 millis")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestContext.TestContext)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe("ModelService — withTier per-phase lifecycle", () => {
  it("spawns+probes a per-phase tier on enter and kills on exit (success path)", async () => {
    const out = await Effect.runPromise(
      withService({}, (svc, log) =>
        Effect.gen(function* () {
          yield* svc.withTier("hindbrain")(Effect.succeed("ok"))
          return yield* log()
        }),
      ),
    )
    // Startup gate already spawned conscious (resident) + forebrain/hindbrain
    // (transient validate-and-release); the runtime withTier spawns hindbrain a
    // SECOND time, so its spawn appears once more after the gate.
    expect(out.spawns[0]).toBe("conscious")
    expect(out.spawns.filter((t) => t === "hindbrain").length).toBe(2)
    expect(out.kills).toContain("hindbrain")
    expect(out.probes).toContain("hindbrain")
  })

  it("kills the per-phase tier even when the wrapped effect FAILS", async () => {
    const exit = await Effect.runPromiseExit(
      withService({}, (svc, log) =>
        Effect.gen(function* () {
          const res = yield* svc.withTier("forebrain")(Effect.fail("boom")).pipe(Effect.either)
          const l = yield* log()
          return { res, l }
        }),
      ),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    const value = (exit as Extract<typeof exit, { _tag: "Success" }>).value
    expect(value.res._tag).toBe("Left")
    expect(value.l.kills).toContain("forebrain")
  })

  it("withTier on a resident tier is a no-op (no extra spawn)", async () => {
    const out = await Effect.runPromise(
      withService({}, (svc, log) =>
        Effect.gen(function* () {
          yield* svc.withTier("conscious")(Effect.succeed("ok"))
          return yield* log()
        }),
      ),
    )
    // conscious spawned exactly once (resident acquire at startup); withTier on
    // a resident tier is a no-op and adds no second conscious spawn.
    expect(out.spawns.filter((t) => t === "conscious").length).toBe(1)
  })
})

describe("ModelService — readiness restart with exponential backoff", () => {
  it("recovers by restarting a server that times out its first 3 readiness budgets, without failing the build", async () => {
    // hindbrain (per-phase, 120_000ms budget) hangs its readiness probe for its
    // first 3 spawn generations → each attempt times out → RESTART. The 4th
    // spawn becomes ready. The layer build must SUCCEED (no fatal surfaced).
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const be = yield* makeFakeBackend({ probeTimeoutFirst: { hindbrain: 3 } })
        const fiber = yield* Effect.fork(Effect.scoped(makeModelService(be)).pipe(Effect.exit))
        // 3 × 120s timeouts + 1s+2s+4s backoff ≈ 367s of virtual time.
        yield* TestClock.adjust("400000 millis")
        const built = yield* Fiber.join(fiber)
        const log = yield* be.log()
        return { built, log }
      }).pipe(Effect.provide(TestContext.TestContext)),
    )
    expect(Exit.isSuccess(out.built)).toBe(true)
    // hindbrain was spawned 4 times: 3 failed-then-restarted + the ready 4th.
    expect(out.log.spawns.filter((t) => t === "hindbrain").length).toBe(4)
    // Each of the 3 stale servers was torn down before the next restart (no leak).
    // The 4th (held) is also killed when the transient startup-gate scope closes.
    expect(out.log.kills.filter((t) => t === "hindbrain").length).toBe(4)
  })

  it("restarts up to 10 times then surfaces the ReadinessError(timedOut) after exhaustion", async () => {
    // hindbrain never becomes ready. Each attempt times out at 120s; restarts are
    // spaced 1s,2s,4s,…,512s. The fiber must NOT be done after the 11 timeouts
    // alone (1320s) — the ~1023s of cumulative backoff must still be pending —
    // proving the delays are real and exponential. Only after the full budget
    // (~2343s) does it surface a timed-out ReadinessError.
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const be = yield* makeFakeBackend({ probeTimeoutFirst: { hindbrain: 1_000_000 } })
        const fiber = yield* Effect.fork(Effect.scoped(makeModelService(be)).pipe(Effect.exit))
        // Past all 11 timeouts (1320s) but inside the pending exponential backoff.
        yield* TestClock.adjust("1400000 millis")
        const mid = yield* Fiber.poll(fiber)
        // Past the remaining backoff (total 2.5M ms > ~2343s).
        yield* TestClock.adjust("1100000 millis")
        const joined = yield* Fiber.join(fiber)
        const log = yield* be.log()
        return { mid, joined, log }
      }).pipe(Effect.provide(TestContext.TestContext)),
    )
    // Still running mid-backoff after the timeouts: backoff delays are real.
    expect(Option.isNone(out.mid)).toBe(true)
    // Terminal failure preserves the ReadinessError(timedOut=true).
    expect(Exit.isFailure(out.joined)).toBe(true)
    const err =
      out.joined._tag === "Failure" ? Cause.failureOption(out.joined.cause) : Option.none()
    expect(Option.isSome(err)).toBe(true)
    const e = (err as Extract<typeof err, { _tag: "Some" }>).value
    expect(e).toBeInstanceOf(ReadinessError)
    expect((e as ReadinessError).timedOut).toBe(true)
    // 11 total attempts (initial + 10 restarts), each spawned + torn down → no leak.
    expect(out.log.spawns.filter((t) => t === "hindbrain").length).toBe(11)
    expect(out.log.kills.filter((t) => t === "hindbrain").length).toBe(11)
    // Restarts targeted ONLY hindbrain: the other tiers were each spawned once.
    expect(out.log.spawns.filter((t) => t === "conscious").length).toBe(1)
    expect(out.log.spawns.filter((t) => t === "forebrain").length).toBe(1)
  })
})

describe("ModelService — adopt-if-healthy", () => {
  it("adopts a healthy resident server: no spawn, isHealthy checked, not killed on teardown", async () => {
    // log() is read after Effect.scoped closes (withService scopes the program),
    // so kills here reflect post-teardown state: an adopted server we did NOT
    // spawn must NOT be killed.
    const out = await Effect.runPromise(
      withService({ healthy: ["conscious"] }, (_svc, log) => log()),
    )
    expect(out.healthChecks).toContain("conscious")
    expect(out.spawns).not.toContain("conscious")
    // don't-kill-what-you-didn't-spawn: adopted server left running.
    expect(out.kills).not.toContain("conscious")
  })
})
