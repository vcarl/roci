import { describe, it, expect, vi, beforeEach } from "vitest"
import { Effect, Ref, Layer } from "effect"
import { demuxEvents } from "./log-demux.js"
import type { InternalEvent } from "./stream-normalizer.js"
import { CharacterLog } from "./log-writer.js"

// Suppress console output during tests
vi.spyOn(console, "log").mockImplementation(() => {})

const mockThought = vi.fn(() => Effect.void)
const mockAction = vi.fn(() => Effect.void)
const mockWord = vi.fn(() => Effect.void)
const mockRaw = vi.fn(() => Effect.void)

const TestCharacterLog = Layer.succeed(
  CharacterLog,
  CharacterLog.of({
    thought: mockThought,
    action: mockAction,
    word: mockWord,
    raw: mockRaw,
  }),
)

const testChar = { name: "testchar", dir: "/tmp/test" } as any

function run(effect: Effect.Effect<void, any, CharacterLog>) {
  return Effect.runPromise(effect.pipe(Effect.provide(TestCharacterLog)))
}

/** Run demuxEvents with a fresh text accumulator, return the accumulated text. */
function runWithAccumulator(
  events: InternalEvent[],
  source: "brain" | "body" = "brain",
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const acc = yield* Ref.make<string[]>([])
      yield* demuxEvents(testChar, events, source, acc)
      return yield* Ref.get(acc)
    }).pipe(Effect.provide(TestCharacterLog)),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("demuxEvents", () => {
  describe("text events", () => {
    it("accumulates text into textAccumulator", async () => {
      const result = await runWithAccumulator([{ type: "text", text: "hello world" }])
      expect(result).toEqual(["hello world"])
    })

    it("accumulates multiple text events in order", async () => {
      const result = await runWithAccumulator([
        { type: "text", text: "first" },
        { type: "text", text: "second" },
        { type: "text", text: "third" },
      ])
      expect(result).toEqual(["first", "second", "third"])
    })

    it("skips accumulation when no textAccumulator provided", async () => {
      const events: InternalEvent[] = [{ type: "text", text: "hello" }]

      // Should not throw
      await run(demuxEvents(testChar, events, "brain"))
    })

    it("logs text to thought log", async () => {
      const events: InternalEvent[] = [{ type: "text", text: "some thought" }]

      await run(demuxEvents(testChar, events, "brain"))

      expect(mockThought).toHaveBeenCalledOnce()
      const entry = mockThought.mock.calls[0][1]
      expect(entry.type).toBe("text")
      expect(entry.text).toBe("some thought")
      expect(entry.source).toBe("brain")
      expect(entry.character).toBe("testchar")
    })
  })

  describe("tool_use events", () => {
    it("logs tool_use to action log", async () => {
      const events: InternalEvent[] = [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la" } },
      ]

      await run(demuxEvents(testChar, events, "body"))

      expect(mockAction).toHaveBeenCalledOnce()
      const entry = mockAction.mock.calls[0][1]
      expect(entry.type).toBe("tool_use")
      expect(entry.tool).toBe("Bash")
      expect(entry.input).toEqual({ command: "ls -la" })
    })

    it("logs social commands to word log", async () => {
      const events: InternalEvent[] = [
        { type: "tool_use", id: "t2", name: "Bash", input: { command: "sm chat send hello" } },
      ]

      await run(demuxEvents(testChar, events, "body"))

      expect(mockWord).toHaveBeenCalledOnce()
      expect(mockAction).toHaveBeenCalledOnce()
    })

    it("does not log non-social Bash commands to word log", async () => {
      const events: InternalEvent[] = [
        { type: "tool_use", id: "t3", name: "Bash", input: { command: "git status" } },
      ]

      await run(demuxEvents(testChar, events, "body"))

      expect(mockWord).not.toHaveBeenCalled()
      expect(mockAction).toHaveBeenCalledOnce()
    })

    it("does not log non-Bash tools to word log even with matching input", async () => {
      const events: InternalEvent[] = [
        { type: "tool_use", id: "t4", name: "Read", input: { command: "sm chat send hello" } },
      ]

      await run(demuxEvents(testChar, events, "body"))

      expect(mockWord).not.toHaveBeenCalled()
    })
  })

  describe("tool_result events", () => {
    it("logs tool_result to action log", async () => {
      const events: InternalEvent[] = [
        { type: "tool_result", toolUseId: "t1", text: "output here" },
      ]

      await run(demuxEvents(testChar, events, "body"))

      expect(mockAction).toHaveBeenCalledOnce()
      const entry = mockAction.mock.calls[0][1]
      expect(entry.type).toBe("tool_result")
      expect(entry.content).toBe("output here")
    })
  })

  describe("non-logging events", () => {
    it("handles system events without logging", async () => {
      const events: InternalEvent[] = [{ type: "system", model: "opus" }]

      await run(demuxEvents(testChar, events, "brain"))

      expect(mockThought).not.toHaveBeenCalled()
      expect(mockAction).not.toHaveBeenCalled()
    })

    it("handles rate_limit events without logging", async () => {
      const events: InternalEvent[] = [{ type: "rate_limit", status: "throttled" }]

      await run(demuxEvents(testChar, events, "brain"))

      expect(mockThought).not.toHaveBeenCalled()
      expect(mockAction).not.toHaveBeenCalled()
    })

    it("handles error events without logging", async () => {
      const events: InternalEvent[] = [{ type: "error", message: "something broke" }]

      await run(demuxEvents(testChar, events, "brain"))

      expect(mockThought).not.toHaveBeenCalled()
      expect(mockAction).not.toHaveBeenCalled()
    })

    it("handles passthrough events without logging", async () => {
      const events: InternalEvent[] = [{ type: "passthrough", rawType: "result" }]

      await run(demuxEvents(testChar, events, "brain"))

      expect(mockThought).not.toHaveBeenCalled()
      expect(mockAction).not.toHaveBeenCalled()
    })
  })

  describe("mixed event sequences", () => {
    it("handles a realistic turn sequence", async () => {
      const result = await runWithAccumulator([
        { type: "system", model: "opus" },
        { type: "thinking", text: "let me think about this" },
        { type: "text", text: "I'll check the files" },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
        { type: "tool_result", toolUseId: "t1", text: "file1.ts\nfile2.ts" },
        { type: "text", text: "Here are the results" },
      ])

      expect(result).toEqual(["I'll check the files", "Here are the results"])
      expect(mockThought).toHaveBeenCalledTimes(2) // 2 text events
      expect(mockAction).toHaveBeenCalledTimes(2) // tool_use + tool_result
    })

    it("handles empty event array", async () => {
      const result = await runWithAccumulator([])

      expect(result).toEqual([])
      expect(mockThought).not.toHaveBeenCalled()
      expect(mockAction).not.toHaveBeenCalled()
    })
  })
})
