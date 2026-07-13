import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import { backoffDelayMs, reconnectWithBackoff, DEFAULT_BACKOFF, type BackoffPolicy } from "./reconnect.js"

describe("reconnect — backoff schedule", () => {
  it("grows geometrically from initialMs and clamps at maxMs", () => {
    const p: BackoffPolicy = { initialMs: 1_000, maxMs: 30_000, factor: 2 }
    // 1s → 2s → 4s → 8s → 16s → 30s (cap) → 30s → …
    expect(backoffDelayMs(1, p)).toBe(1_000)
    expect(backoffDelayMs(2, p)).toBe(2_000)
    expect(backoffDelayMs(3, p)).toBe(4_000)
    expect(backoffDelayMs(4, p)).toBe(8_000)
    expect(backoffDelayMs(5, p)).toBe(16_000)
    expect(backoffDelayMs(6, p)).toBe(30_000) // 32s clamped to 30s cap
    expect(backoffDelayMs(7, p)).toBe(30_000)
    expect(backoffDelayMs(50, p)).toBe(30_000) // stays capped forever
  })

  it("the DEFAULT policy is the documented 1s→30s cap schedule", () => {
    expect(backoffDelayMs(1, DEFAULT_BACKOFF)).toBe(1_000)
    expect(backoffDelayMs(6, DEFAULT_BACKOFF)).toBe(30_000)
  })

  it("floors attempt at 1 (defensive)", () => {
    const p: BackoffPolicy = { initialMs: 500, maxMs: 5_000, factor: 2 }
    expect(backoffDelayMs(0, p)).toBe(500)
    expect(backoffDelayMs(-3, p)).toBe(500)
  })
})

describe("reconnect — teardown-then-redial ordering", () => {
  it("tears the previous socket down BEFORE the first dial", async () => {
    const order: string[] = []
    const program = reconnectWithBackoff<string>("dead-socket", {
      teardown: (prev) => Effect.sync(() => order.push(`teardown:${prev}`)),
      dial: Effect.sync(() => {
        order.push("dial")
        return "fresh-socket"
      }),
      emit: () => Effect.void,
      sleep: () => Effect.void,
    })
    const result = await Effect.runPromise(program)
    expect(result).toBe("fresh-socket")
    expect(order).toEqual(["teardown:dead-socket", "dial"])
  })

  it("skips teardown when there is no previous socket (previous === null)", async () => {
    const order: string[] = []
    const program = reconnectWithBackoff<string>(null, {
      teardown: () => Effect.sync(() => order.push("teardown")),
      dial: Effect.sync(() => {
        order.push("dial")
        return "s"
      }),
      emit: () => Effect.void,
      sleep: () => Effect.void,
    })
    await Effect.runPromise(program)
    expect(order).toEqual(["dial"])
  })

  it("a hung/failing teardown never blocks the redial (teardown error swallowed)", async () => {
    const order: string[] = []
    const program = reconnectWithBackoff<string>("dead", {
      teardown: () => Effect.fail(new Error("close hung")),
      dial: Effect.sync(() => {
        order.push("dial")
        return "fresh"
      }),
      emit: () => Effect.void,
      sleep: () => Effect.void,
    })
    const result = await Effect.runPromise(program)
    expect(result).toBe("fresh")
    expect(order).toEqual(["dial"])
  })
})

describe("reconnect — indefinite retry with backoff", () => {
  it("retries failed dials, sleeping the backoff schedule, until one succeeds", async () => {
    const sleeps: number[] = []
    let dialCount = 0
    const program = reconnectWithBackoff<string>("dead", {
      teardown: () => Effect.void,
      // Fail the first 5 dials, succeed on the 6th.
      dial: Effect.suspend(() => {
        dialCount += 1
        return dialCount <= 5
          ? Effect.fail(new Error(`dial ${dialCount} refused`))
          : Effect.succeed("connected")
      }),
      emit: () => Effect.void,
      sleep: (ms) => Effect.sync(() => sleeps.push(ms)),
      policy: { initialMs: 1_000, maxMs: 30_000, factor: 2 },
    })
    const result = await Effect.runPromise(program)
    expect(result).toBe("connected")
    expect(dialCount).toBe(6)
    // One sleep per failed attempt (5), following the capped schedule.
    expect(sleeps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000])
  })

  it("emits a restored line only after a genuine reconnect (attempt > 1)", async () => {
    const emits: string[] = []
    // Fails once, then succeeds → should announce restoration.
    let n = 0
    await Effect.runPromise(
      reconnectWithBackoff<string>("dead", {
        teardown: () => Effect.void,
        dial: Effect.suspend(() => (++n === 1 ? Effect.fail(new Error("x")) : Effect.succeed("s"))),
        emit: (kind, msg) => Effect.sync(() => emits.push(`${kind}:${msg}`)),
        sleep: () => Effect.void,
      }),
    )
    expect(emits.some((e) => e.startsWith("error:") && /retrying in/.test(e))).toBe(true)
    expect(emits.some((e) => e.startsWith("system:") && /Reconnected/.test(e))).toBe(true)
  })

  it("stays silent about restoration when the first dial succeeds immediately", async () => {
    const emits: string[] = []
    await Effect.runPromise(
      reconnectWithBackoff<string>(null, {
        teardown: () => Effect.void,
        dial: Effect.succeed("s"),
        emit: (kind, msg) => Effect.sync(() => emits.push(`${kind}:${msg}`)),
        sleep: () => Effect.void,
      }),
    )
    expect(emits).toEqual([])
  })
})
