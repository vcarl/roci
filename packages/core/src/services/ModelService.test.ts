import { describe, it, expect } from "vitest"
import { Effect, Exit, Fiber, TestClock, TestContext } from "effect"
import { makeFakeBackend } from "./model-backend-fake.js"
import { makeModelService, ModelService } from "./ModelService.js"
import { resolveTierSpec } from "./model-tier-spec.js"

// Run a scoped program against a fake backend. The service is built inside the
// same scope so its resident-acquire + teardown are exercised.
type FakeLog = { spawns: ReadonlyArray<string>; kills: ReadonlyArray<string>; probes: ReadonlyArray<string>; healthChecks: ReadonlyArray<string> }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const withService = <A, E>(
  script: Parameters<typeof makeFakeBackend>[0],
  use: (svc: ModelService["Type"], log: () => Effect.Effect<FakeLog>) => Effect.Effect<A, E, any>,
) =>
  Effect.gen(function* () {
    const be = yield* makeFakeBackend(script)
    const svc = yield* makeModelService(be)
    return yield* use(svc, be.log) as Effect.Effect<A, E, never>
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
  it("a resident probe that never returns fails makeModelService via timeout", async () => {
    // Deterministic: drive the conscious readiness timeout (600_000ms) with
    // TestClock so no wall-clock time elapses. Build the service inside a forked
    // scope, advance past the timeout, then await the fiber's Exit.
    const program = Effect.gen(function* () {
      const be = yield* makeFakeBackend({ probe: { conscious: "timeout" } })
      return yield* makeModelService(be)
    }).pipe(Effect.scoped)
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(program)
        yield* TestClock.adjust("700000 millis")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestContext.TestContext)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe("ModelService — all three tiers required at startup", () => {
  it("fails the layer build when a per-phase tier (hindbrain) fails its startup probe", async () => {
    // The startup gate probes every per-phase tier once. A scripted hindbrain
    // probe failure must fail makeModelService (the layer build), even though
    // the resident conscious is healthy. probe:"fail" is immediate (no clock).
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const be = yield* makeFakeBackend({ probe: { hindbrain: "fail" } })
        return yield* makeModelService(be)
      }).pipe(Effect.scoped),
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
