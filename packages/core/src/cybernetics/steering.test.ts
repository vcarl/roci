import { describe, it, expect } from "vitest"
import { Effect, Queue, Chunk, Stream } from "effect"
import { makeSteeringQueue, buildSteeredStdinStream } from "./steering.js"
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

describe("buildSteeredStdinStream", () => {
  it("emits the task line first, then a steer line per directive (ordering)", async () => {
    const lines = await Effect.runPromise(
      Effect.gen(function* () {
        const q = yield* makeSteeringQueue()
        yield* Queue.offer(q, { text: "go left" })
        // Take exactly task + first steer, without ending the session, so the
        // assertion is deterministic (no shutdown timing involved).
        const stream = buildSteeredStdinStream("start", q).pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.take(2),
        )
        const collected = yield* Stream.runCollect(stream)
        return Chunk.toReadonlyArray(collected)
      }),
    )
    expect(JSON.parse(lines[0])).toEqual({ v: 1, type: "task", text: "start" })
    expect(JSON.parse(lines[1])).toEqual({ v: 1, type: "steer", text: "go left" })
  })

  it("run-to-completion degenerate case: shut down with nothing offered → task then end", async () => {
    const lines = await Effect.runPromise(
      Effect.gen(function* () {
        const q = yield* makeSteeringQueue()
        yield* Queue.shutdown(q)
        const stream = buildSteeredStdinStream("start", q).pipe(
          Stream.decodeText(),
          Stream.splitLines,
        )
        const collected = yield* Stream.runCollect(stream)
        return Chunk.toReadonlyArray(collected)
      }),
    )
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { v: 1, type: "task", text: "start" },
      { v: 1, type: "end" },
    ])
  })
})

describe("DEFAULT_STEER_CADENCE_TICKS", () => {
  it("is a positive tick count", () => {
    expect(DEFAULT_STEER_CADENCE_TICKS).toBe(3)
  })
})
