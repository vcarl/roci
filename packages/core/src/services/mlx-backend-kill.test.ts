import { describe, it, expect } from "vitest"
import { Deferred, Effect, Fiber, Stream, TestClock, TestContext } from "effect"
import { NodeContext } from "@effect/platform-node"
import { makeMlxBackend, KILL_GRACE_MS } from "./mlx-backend.js"
import type { SpawnedProcess, KillSeam } from "./mlx-backend.js"
import { acquireReady } from "./ModelService.js"
import { resolveTierSpec } from "./model-tier-spec.js"

// These tests drive the mlx backend's kill/teardown through the injectable seams
// (`startProcess` + `killSeam`) so they NEVER spawn a real mlx_lm.server and
// never signal a real process. The load-bearing invariant under test: closing
// the scope that owns a SPAWNED server runs the kill finalizer, which SIGTERMs
// the whole PROCESS GROUP (negative pid), then AWAITS a race of "process exited"
// vs a bounded grace, and only escalates to SIGKILL (on the group) if the
// process is still alive when the grace elapses.
//
// The escalation is awaited INSIDE the finalizer (not on a daemon fiber) so that
// on a real whole-app SIGTERM, NodeRuntime.runMain — which runs finalizers to
// completion before process.exit but does NOT await daemons — actually blocks on
// the SIGKILL. These tests model that awaited behavior: they do not rely on the
// runtime keeping a detached fiber alive across the clock advance.

const spec = resolveTierSpec("hindbrain") // per-phase, fast timeout

// Drive a scope-close whose kill finalizer BLOCKS awaiting the SIGTERM grace.
// We fork the scoped effect so the finalizer runs SIGTERM and arms its grace
// timer, then advance the TestClock past the grace to resolve it, then join the
// fiber (the fork → adjust → join idiom used in ModelService.test). Used only for
// the stuck/escalation paths; the fast path needs no clock advance.
const runScopedThenAdvance = <A, E, R>(
  scoped: Effect.Effect<A, E, R>,
  byMillis: number,
) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.fork(Effect.scoped(scoped))
    // The forked fiber acquires, the scope closes, and the kill finalizer SIGTERMs
    // then suspends on its grace race; advancing the clock past the grace resolves
    // that race (matches the fork → adjust → join idiom used in ModelService.test).
    yield* TestClock.adjust(`${byMillis} millis`)
    return yield* Fiber.join(fiber)
  })

// A fake process whose exit is driven by `awaitExit`. By default it never exits
// (the "stuck server" case). Pass a Deferred/effect to model a process that
// exits (the fast path / liveness-gate cases).
const fakeProcess = (
  pid: number,
  awaitExit: Effect.Effect<void> = Effect.never,
): SpawnedProcess => ({
  pid,
  stderr: Stream.empty,
  awaitExit,
})

// A KillSeam spy that records every (target, signal) it's asked to send, and can
// be told which targets are "already gone" (so send returns false, exercising
// the group→pid fallback).
const makeKillSpy = (goneTargets: ReadonlyArray<number> = []) => {
  const calls: Array<{ target: number; signal: "SIGTERM" | "SIGKILL" }> = []
  const seam: KillSeam = {
    send: (target, signal) => {
      calls.push({ target, signal })
      return !goneTargets.includes(target)
    },
  }
  return { seam, calls }
}

// A fetch whose FIRST call (acquireReady's isHealthy check) reports not-ready so
// the server is SPAWNED (not adopted), then every subsequent call (the readiness
// probe) confirms the expected model so the gate passes instantly. This forces
// the spawn → probe → kill-on-close path the kill finalizer lives on.
const spawnThenReadyFetch = (): typeof fetch => {
  let calls = 0
  return (async () => {
    calls += 1
    const ready = calls > 1
    return {
      ok: true,
      status: 200,
      json: async () => (ready ? { model: spec.model } : {}),
    } as unknown as Response
  }) as unknown as typeof fetch
}

// A fetch that always confirms the expected model — used for the ADOPT case,
// where isHealthy is true on the first call so no spawn/kill happens.
const alwaysReadyFetch = (): typeof fetch =>
  (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ model: spec.model }),
    }) as unknown as Response) as unknown as typeof fetch

describe("mlx backend — kill targets the process group and escalates", () => {
  it("FAST PATH: when the process exits promptly after SIGTERM, sends NO SIGKILL and returns without the full grace", async () => {
    const PID = 4242
    const { seam, calls } = makeKillSpy()

    const program = Effect.gen(function* () {
      // The process exits immediately (awaitExit completes) so the kill finalizer
      // wins the race on the exit side and must NOT escalate.
      const exited = yield* Deferred.make<void>()
      yield* Deferred.succeed(exited, undefined)
      const backend = yield* makeMlxBackend({
        fetchImpl: spawnThenReadyFetch(),
        startProcess: () => Effect.succeed(fakeProcess(PID, Deferred.await(exited))),
        killSeam: seam,
      })
      // No TestClock advance: the finalizer must complete on its own because the
      // exit side of the race resolves immediately. If the finalizer blocked on
      // the full grace, this effect would hang (grace is never advanced).
      yield* Effect.scoped(acquireReady(backend, spec))
    }).pipe(Effect.provide(NodeContext.layer), Effect.provide(TestContext.TestContext))

    await Effect.runPromise(program)

    // SIGTERM targeted the GROUP (negative pid) — the orphan-fix invariant.
    expect(calls[0]).toEqual({ target: -PID, signal: "SIGTERM" })
    // The process exited within the grace, so NO SIGKILL was ever sent.
    expect(calls.some((c) => c.signal === "SIGKILL")).toBe(false)
  })

  it("STUCK PATH: when the process never exits, escalates to SIGKILL on the group after the grace", async () => {
    const PID = 4243
    const { seam, calls } = makeKillSpy()

    // The finalizer blocks awaiting (exit vs grace); the process never exits, so
    // only advancing the TestClock past the grace lets it resolve and SIGKILL.
    const program = Effect.gen(function* () {
      const backend = yield* makeMlxBackend({
        fetchImpl: spawnThenReadyFetch(),
        startProcess: () => Effect.succeed(fakeProcess(PID, Effect.never)),
        killSeam: seam,
      })
      // The scope close blocks in the finalizer's grace race; the process never
      // exits, so advancing the clock past the grace resolves it on the grace
      // side and the finalizer fires SIGKILL.
      yield* runScopedThenAdvance(acquireReady(backend, spec), KILL_GRACE_MS + 1)
    }).pipe(Effect.provide(NodeContext.layer), Effect.provide(TestContext.TestContext))

    await Effect.runPromise(program)

    expect(calls[0]).toEqual({ target: -PID, signal: "SIGTERM" })
    const kills = calls.filter((c) => c.signal === "SIGKILL")
    expect(kills.length).toBe(1)
    // The escalation SIGKILL must target the GROUP (negative pid).
    expect(kills[0]).toEqual({ target: -PID, signal: "SIGKILL" })
    // Group SIGTERM succeeded, so the bare positive leader pid was never signalled.
    expect(calls.some((c) => c.target === PID)).toBe(false)
  })

  it("LIVENESS GATE: does NOT send SIGKILL if the process exits during the grace", async () => {
    const PID = 4244
    const { seam, calls } = makeKillSpy()
    const EXIT_AT = KILL_GRACE_MS - 1 // exits just before the grace elapses

    const program = Effect.gen(function* () {
      // The process exits part-way through the grace; the exit side of the race
      // wins, so the finalizer must observe still-alive=false and skip SIGKILL.
      const backend = yield* makeMlxBackend({
        fetchImpl: spawnThenReadyFetch(),
        startProcess: () =>
          Effect.succeed(
            fakeProcess(PID, Effect.sleep(`${EXIT_AT} millis`)),
          ),
        killSeam: seam,
      })
      // Advance past the grace: the exit sleep (EXIT_AT < grace) fires first, so
      // the race resolves on the exit side and the liveness gate skips SIGKILL.
      yield* runScopedThenAdvance(acquireReady(backend, spec), KILL_GRACE_MS + 1)
    }).pipe(Effect.provide(NodeContext.layer), Effect.provide(TestContext.TestContext))

    await Effect.runPromise(program)

    expect(calls[0]).toEqual({ target: -PID, signal: "SIGTERM" })
    // Process exited inside the grace → liveness gate suppresses SIGKILL.
    expect(calls.some((c) => c.signal === "SIGKILL")).toBe(false)
  })

  it("falls back to the bare pid when the group signal can't be delivered (stuck → SIGKILL)", async () => {
    const PID = 5151
    // Mark the GROUP target (-PID) as gone so the group send returns false and the
    // kill must fall back to the positive pid for BOTH SIGTERM and SIGKILL.
    const { seam, calls } = makeKillSpy([-PID])

    const program = Effect.gen(function* () {
      const backend = yield* makeMlxBackend({
        fetchImpl: spawnThenReadyFetch(),
        startProcess: () => Effect.succeed(fakeProcess(PID, Effect.never)),
        killSeam: seam,
      })
      yield* runScopedThenAdvance(acquireReady(backend, spec), KILL_GRACE_MS + 1)
    }).pipe(Effect.provide(NodeContext.layer), Effect.provide(TestContext.TestContext))

    await Effect.runPromise(program)

    // SIGTERM tried the group first, then fell back to the bare pid.
    expect(calls[0]).toEqual({ target: -PID, signal: "SIGTERM" })
    expect(calls[1]).toEqual({ target: PID, signal: "SIGTERM" })
    // SIGKILL likewise: group attempt then pid fallback.
    const kills = calls.filter((c) => c.signal === "SIGKILL")
    expect(kills).toEqual([
      { target: -PID, signal: "SIGKILL" },
      { target: PID, signal: "SIGKILL" },
    ])
  })

  it("kills exactly once per spawned server when the scope closes (stuck path)", async () => {
    const PID = 6262
    const { seam, calls } = makeKillSpy()

    const program = Effect.gen(function* () {
      const backend = yield* makeMlxBackend({
        fetchImpl: spawnThenReadyFetch(),
        startProcess: () => Effect.succeed(fakeProcess(PID, Effect.never)),
        killSeam: seam,
      })
      yield* runScopedThenAdvance(acquireReady(backend, spec), KILL_GRACE_MS + 1)
    }).pipe(Effect.provide(NodeContext.layer), Effect.provide(TestContext.TestContext))

    await Effect.runPromise(program)

    // Exactly one SIGTERM and one SIGKILL for the group — the finalizer ran once.
    expect(calls.filter((c) => c.signal === "SIGTERM").length).toBe(1)
    expect(calls.filter((c) => c.signal === "SIGKILL").length).toBe(1)
  })

  it("does not signal anything for an adopted (not spawned) server", async () => {
    // A healthy/adopted server is never killed on teardown. Script the health
    // check to report healthy so acquireReady adopts (no spawn, no kill).
    const { seam, calls } = makeKillSpy()

    const program = Effect.gen(function* () {
      const backend = yield* makeMlxBackend({
        // isHealthy uses probeOnce(spec); an always-ready fetch makes the server
        // "healthy" on the first check so acquireReady ADOPTS it (no spawn, no kill).
        fetchImpl: alwaysReadyFetch(),
        startProcess: () => Effect.succeed(fakeProcess(9999)),
        killSeam: seam,
      })
      yield* Effect.scoped(acquireReady(backend, spec))
      yield* TestClock.adjust(`${KILL_GRACE_MS + 1} millis`)
      yield* Effect.yieldNow()
    }).pipe(Effect.provide(NodeContext.layer), Effect.provide(TestContext.TestContext))

    await Effect.runPromise(program)

    expect(calls.length).toBe(0)
  })
})
