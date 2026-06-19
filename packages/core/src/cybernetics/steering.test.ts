import { describe, it, expect } from "vitest"
import { Effect, Queue, Chunk } from "effect"
import { makeSteeringQueue } from "./steering.js"
import { DEFAULT_STEER_CADENCE_TICKS } from "../cortex/loop.js"

describe("makeSteeringQueue", () => {
  it("coalesces: a newer directive supersedes an un-consumed older one", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const q = yield* makeSteeringQueue()
        yield* Queue.offer(q, { text: "first" })
        yield* Queue.offer(q, { text: "second" })
        const items = yield* Queue.takeAll(q)
        return Chunk.toReadonlyArray(items)
      }),
    )
    expect(result).toEqual([{ text: "second" }])
  })
})

describe("DEFAULT_STEER_CADENCE_TICKS", () => {
  it("is a positive tick count", () => {
    expect(DEFAULT_STEER_CADENCE_TICKS).toBe(3)
  })
})
