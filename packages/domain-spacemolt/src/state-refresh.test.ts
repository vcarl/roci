import { describe, it, expect } from "vitest"
import { Effect, Ref } from "effect"
import { makeStateRefreshLoop, type StateRefreshDeps } from "./state-refresh.js"

/**
 * Collects emit() calls so tests can assert on what the loop escalated. Each
 * entry is `${kind}: ${msg}`.
 */
function makeEmitSink() {
  const calls: Array<{ kind: "system" | "error"; msg: string }> = []
  const emit = (kind: "system" | "error", msg: string) =>
    Effect.sync(() => {
      calls.push({ kind, msg })
    })
  return { calls, emit }
}

/** A controllable clock: tests advance `t` and read it via the `now` Effect. */
function makeClock(start = 0) {
  let t = start
  return {
    now: Effect.sync(() => t),
    set: (v: number) => {
      t = v
    },
    advance: (dt: number) => {
      t += dt
    },
  }
}

const baseDeps = (over: Partial<StateRefreshDeps>): StateRefreshDeps => ({
  performRefresh: Effect.succeed(true),
  emit: () => Effect.void,
  status: () => "open",
  intervalMs: 20,
  timeoutMs: 30,
  staleCeilingMs: 100,
  ...over,
})

describe("state-refresh — latch un-wedge (Change 1)", () => {
  it("a never-resolving performRefresh still releases the latch so the NEXT refreshOnce runs", async () => {
    const { calls, emit } = makeEmitSink()
    // First refresh hangs forever (half-open socket); second succeeds.
    let call = 0
    const performRefresh = Effect.suspend(() => {
      call += 1
      return call === 1 ? Effect.never : Effect.succeed(true)
    })

    const program = Effect.gen(function* () {
      const loop = yield* makeStateRefreshLoop(
        baseDeps({ performRefresh, emit, timeoutMs: 30, timeoutGraceMs: 10 }),
      )
      // First call: the underlying refresh never resolves. It MUST still
      // complete (bounded at the Effect layer) and reset the latch.
      yield* loop.refreshOnce
      // Second call: latch was released, so this actually runs the (succeeding)
      // performRefresh — proving the loop did not wedge.
      yield* loop.refreshOnce
      return call
    })

    const ran = await Effect.runPromise(program)
    // performRefresh was invoked twice: the hung first and the successful second.
    expect(ran).toBe(2)
    // A timeout error was emitted for the wedge.
    expect(calls.some((c) => c.kind === "error" && /stale|timed out|timeout/i.test(c.msg))).toBe(true)
  })

  it("a successful refresh records lastOkAt (watchdog stays silent afterward)", async () => {
    const { calls, emit } = makeEmitSink()
    const clock = makeClock(1000)
    const program = Effect.gen(function* () {
      const loop = yield* makeStateRefreshLoop(
        baseDeps({ emit, now: clock.now, performRefresh: Effect.succeed(true) }),
      )
      yield* loop.refreshOnce // records lastOkAt = 1000
      clock.set(1050) // 50ms later, under the 100ms ceiling
      yield* loop.checkStale
    })
    await Effect.runPromise(program)
    expect(calls.filter((c) => c.kind === "error")).toHaveLength(0)
  })
})

describe("state-refresh — staleness watchdog (Change 2)", () => {
  it("escalates when stale: emits an error with age + status, resets latch, triggers a refresh", async () => {
    const { calls, emit } = makeEmitSink()
    const clock = makeClock(0)
    let refreshes = 0
    const performRefresh = Effect.sync(() => {
      refreshes += 1
      return false // error frame → never updates lastOkAt, stays stale
    })

    const program = Effect.gen(function* () {
      const loop = yield* makeStateRefreshLoop(
        baseDeps({
          emit,
          now: clock.now,
          performRefresh,
          status: () => "reconnecting",
          staleCeilingMs: 100,
        }),
      )
      // lastOkAt seeded at construction (t=0). Advance well past the ceiling.
      // Use a seconds-scale age (210_000ms = 210s) so the rendered age is exact.
      clock.set(210_000)
      yield* loop.checkStale
      // Let the forked recovery refresh run.
      yield* Effect.sleep("20 millis")
    })
    await Effect.runPromise(program)

    const err = calls.find((c) => c.kind === "error")
    expect(err).toBeDefined()
    expect(err!.msg).toContain("210s")
    expect(err!.msg).toContain("reconnecting")
    // (c) a recovery refresh was triggered.
    expect(refreshes).toBeGreaterThanOrEqual(1)
  })

  it("stays silent when a successful refresh is recent", async () => {
    const { calls, emit } = makeEmitSink()
    const clock = makeClock(0)
    const program = Effect.gen(function* () {
      const loop = yield* makeStateRefreshLoop(
        baseDeps({ emit, now: clock.now, staleCeilingMs: 100 }),
      )
      yield* loop.refreshOnce // lastOkAt = 0
      clock.set(80) // within ceiling
      yield* loop.checkStale
    })
    await Effect.runPromise(program)
    expect(calls.filter((c) => c.kind === "error")).toHaveLength(0)
  })

  it("forks the injected onStale recovery (not refreshOnce) when provided", async () => {
    const { emit } = makeEmitSink()
    const clock = makeClock(0)
    let refreshes = 0
    let staleRecoveries = 0
    const program = Effect.gen(function* () {
      const loop = yield* makeStateRefreshLoop(
        baseDeps({
          emit,
          now: clock.now,
          // performRefresh would bump this if the watchdog re-polled the socket…
          performRefresh: Effect.sync(() => {
            refreshes += 1
            return false
          }),
          // …but with onStale wired, recovery must run THIS instead.
          onStale: Effect.sync(() => {
            staleRecoveries += 1
          }),
          staleCeilingMs: 100,
        }),
      )
      clock.set(200)
      yield* loop.checkStale
      yield* Effect.sleep("20 millis") // let the forked recovery run
    })
    await Effect.runPromise(program)
    expect(staleRecoveries).toBe(1)
    // The default refreshOnce recovery must NOT have fired.
    expect(refreshes).toBe(0)
  })

  it("throttles: at most one escalation per ceiling window while continuously stale", async () => {
    const { calls, emit } = makeEmitSink()
    const clock = makeClock(0)
    const program = Effect.gen(function* () {
      const loop = yield* makeStateRefreshLoop(
        baseDeps({
          emit,
          now: clock.now,
          performRefresh: Effect.succeed(false), // never recovers
          staleCeilingMs: 100,
        }),
      )
      clock.set(200)
      yield* loop.checkStale // escalate #1 (lastEscalatedAt = 200)
      clock.set(250)
      yield* loop.checkStale // throttled (250 - 200 = 50 < 100)
      clock.set(280)
      yield* loop.checkStale // throttled
      clock.set(320)
      yield* loop.checkStale // escalate #2 (320 - 200 = 120 >= 100)
    })
    await Effect.runPromise(program)
    const errors = calls.filter((c) => c.kind === "error")
    expect(errors).toHaveLength(2)
  })
})
