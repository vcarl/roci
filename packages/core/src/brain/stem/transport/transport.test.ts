import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect, Layer, Ref, Fiber, Clock, TestClock, TestContext } from "effect"
import { Command } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  runTransport,
  runHeartbeat,
  HEARTBEAT_INTERVAL_MS,
  parseStreamJson,
  isAuthError,
} from "./transport.js"
import { normalizeClaude, normalizeOpenCode } from "../../../logging/stream-normalizer.js"
import { CharacterLog } from "../../../logging/log-writer.js"
import type { UnifiedEvent } from "../../../logging/events.js"
import { ARGS_SUMMARY_MAX, setEpisodeLogRoot, resetEpisodeContext } from "../../../logging/episodes.js"

const StubCharacterLog = Layer.succeed(
  CharacterLog,
  CharacterLog.of({ emit: () => Effect.void }),
)
// NodeContext.layer provides a real CommandExecutor (runs actual subprocesses).
const deps = Layer.merge(NodeContext.layer, StubCharacterLog)

const char = { name: "ada", dir: "/work/players/ada/me" }

describe("parseStreamJson", () => {
  it("returns the object for valid JSON, null otherwise", () => {
    expect(parseStreamJson('{"a":1}')).toEqual({ a: 1 })
    expect(parseStreamJson("not json")).toBeNull()
  })
})

describe("isAuthError", () => {
  it("detects auth failures", () => {
    expect(isAuthError("Error 401 Unauthorized")).toBe(true)
    expect(isAuthError("invalid bearer token")).toBe(true)
    expect(isAuthError("everything fine")).toBe(false)
  })
})

describe("runHeartbeat", () => {
  const INTERVAL = 30_000

  it("logs a heartbeat after a full silent interval, and re-logs each further silent interval", async () => {
    const program = Effect.gen(function* () {
      const beats = yield* Ref.make<number[]>([])
      const lastActivityAt = yield* Ref.make(yield* Clock.currentTimeMillis)
      const fiber = yield* Effect.fork(
        runHeartbeat(lastActivityAt, INTERVAL, (s) =>
          Ref.update(beats, (b) => [...b, s]),
        ),
      )

      // Just shy of one interval: no beat yet.
      yield* TestClock.adjust(`${INTERVAL - 1} millis`)
      expect(yield* Ref.get(beats)).toEqual([])

      // Cross the first interval boundary: one beat (~30s silent).
      yield* TestClock.adjust("1 millis")
      expect(yield* Ref.get(beats)).toEqual([30])

      // Another full silent interval: a second beat (~60s silent).
      yield* TestClock.adjust(`${INTERVAL} millis`)
      expect(yield* Ref.get(beats)).toEqual([30, 60])

      yield* Fiber.interrupt(fiber)
    }).pipe(Effect.provide(TestContext.TestContext))

    await Effect.runPromise(program)
  })

  it("does NOT fire while output keeps arriving (liveness resets the clock)", async () => {
    const program = Effect.gen(function* () {
      const beats = yield* Ref.make<number[]>([])
      const lastActivityAt = yield* Ref.make(yield* Clock.currentTimeMillis)
      const fiber = yield* Effect.fork(
        runHeartbeat(lastActivityAt, INTERVAL, (s) =>
          Ref.update(beats, (b) => [...b, s]),
        ),
      )

      // Emit a line every (INTERVAL - 1)ms for several intervals: the activity
      // clock is always refreshed before the heartbeat's silence check fires.
      for (let i = 0; i < 4; i++) {
        yield* TestClock.adjust(`${INTERVAL - 1} millis`)
        yield* Ref.set(lastActivityAt, yield* Clock.currentTimeMillis)
        yield* TestClock.adjust("1 millis")
      }
      expect(yield* Ref.get(beats)).toEqual([])

      yield* Fiber.interrupt(fiber)
    }).pipe(Effect.provide(TestContext.TestContext))

    await Effect.runPromise(program)
  })

  it("threads the role through the logging callback (default interval is 30s)", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(30_000)
  })
})

describe("runTransport", () => {
  it("accumulates text from streamed assistant events", async () => {
    // A real subprocess that prints one claude stream-json assistant line.
    const line =
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}'
    const command = Command.make("bash", "-c", `printf '%s\\n' '${line}'`)

    const result = await Effect.runPromise(
      Effect.provide(
        runTransport({
          command,
          normalize: normalizeClaude,
          runtimeTag: "claude",
          char,
          role: "body",
          timeoutMs: 5000,
        }),
        deps,
      ),
    )
    expect(result.timedOut).toBe(false)
    expect(result.output).toContain("hello")
  })

  it("emits liveness heartbeat lines while a real process stays silent", async () => {
    // Recording CharacterLog: capture every emitted system message.
    const messages: string[] = []
    const RecordingLog = Layer.succeed(
      CharacterLog,
      CharacterLog.of({
        emit: (_char, event) =>
          Effect.sync(() => {
            if (event.kind === "system") messages.push(event.message)
          }),
      }),
    )
    const recDeps = Layer.merge(NodeContext.layer, RecordingLog)

    // Silent for ~400ms, then exits. With a 50ms heartbeat that's many beats.
    const command = Command.make("bash", "-c", "sleep 0.4")
    const result = await Effect.runPromise(
      Effect.provide(
        runTransport({
          command,
          normalize: normalizeClaude,
          runtimeTag: "claude",
          char,
          role: "body",
          timeoutMs: 5000,
          heartbeatMs: 50,
        }),
        recDeps,
      ),
    )
    expect(result.timedOut).toBe(false)
    const beats = messages.filter((m) => m.startsWith("still running — no output for"))
    expect(beats.length).toBeGreaterThan(0)
    expect(beats[0]).toMatch(/still running — no output for \d+s \(awaiting model\/tool\)/)
  })

  it("times out a long-running process and reports timedOut", async () => {
    const command = Command.make("bash", "-c", "sleep 5")
    const result = await Effect.runPromise(
      Effect.provide(
        runTransport({
          command,
          normalize: normalizeClaude,
          runtimeTag: "claude",
          char,
          role: "body",
          timeoutMs: 50,
        }),
        deps,
      ),
    )
    expect(result.timedOut).toBe(true)
  })

  it("logs stderr in full (no 500-char truncation)", async () => {
    const big = "E".repeat(1500)
    const emitted: UnifiedEvent[] = []
    const RecordingLog = Layer.succeed(
      CharacterLog,
      CharacterLog.of({
        emit: (_char, event) =>
          Effect.sync(() => {
            emitted.push(event)
          }),
      }),
    )
    const recDeps = Layer.merge(NodeContext.layer, RecordingLog)

    const command = Command.make("node", "-e", `process.stderr.write("E".repeat(1500))`)
    await Effect.runPromise(
      Effect.provide(
        runTransport({
          command,
          normalize: normalizeClaude,
          runtimeTag: "claude",
          char,
          role: "body",
          timeoutMs: 5000,
        }),
        recDeps,
      ),
    )

    const stderrEvents = emitted.filter(
      (e) => e.kind === "system" && /^stderr:/.test((e as { message?: string }).message ?? ""),
    )
    expect(stderrEvents.length).toBe(1)
    expect((stderrEvents[0] as { message: string }).message).toContain(big)
  })
})

describe("runTransport captureFromRaw", () => {
  it("captures the first non-null value and returns it as sessionId", async () => {
    const l1 = '{"type":"step_start","sessionID":"ses_abc","part":{"model":"local/conscious"}}'
    const l2 = '{"type":"text","part":{"text":"hello"}}'
    const command = Command.make("bash", "-c", `printf '%s\\n%s\\n' '${l1}' '${l2}'`)

    const result = await Effect.runPromise(
      Effect.provide(
        runTransport({
          command,
          normalize: normalizeOpenCode,
          runtimeTag: "opencode",
          char,
          role: "body",
          timeoutMs: 5000,
          captureFromRaw: (raw) => (typeof raw.sessionID === "string" ? raw.sessionID : null),
        }),
        deps,
      ),
    )
    expect(result.sessionId).toBe("ses_abc")
    expect(result.output).toContain("hello")
  })

  it("leaves sessionId undefined when no capture hook is given", async () => {
    const command = Command.make("bash", "-c", `printf '%s\\n' '{"type":"text","part":{"text":"hi"}}'`)
    const result = await Effect.runPromise(
      Effect.provide(
        runTransport({ command, normalize: normalizeOpenCode, runtimeTag: "opencode", char, role: "body", timeoutMs: 5000 }),
        deps,
      ),
    )
    expect(result.sessionId).toBeUndefined()
  })
})

describe("runTransport tool episodes", () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "episodes-transport-"))
    setEpisodeLogRoot(root)
    resetEpisodeContext("ada")
  })
  afterEach(() => {
    setEpisodeLogRoot(null)
    fs.rmSync(root, { recursive: true, force: true })
  })

  const toolFile = () => path.join(root, "players", "ada", "logs", "episodes-tool.jsonl")

  const toolLine = (status: string) =>
    JSON.stringify({
      type: "tool_use",
      part: {
        id: "prt_1",
        tool: "bash",
        state: {
          status,
          input: { command: "x".repeat(500) },
          output: "SECRET_TOOL_OUTPUT",
          time: { start: 1000, end: 1450 },
        },
      },
    })

  it("appends one truncated tool episode per completed opencode tool call — never the output", async () => {
    const command = Command.make("bash", "-c", `printf '%s\\n' '${toolLine("completed")}'`)
    await Effect.runPromise(
      Effect.provide(
        runTransport({ command, normalize: normalizeOpenCode, runtimeTag: "opencode", char, role: "body", timeoutMs: 5000 }),
        deps,
      ),
    )
    const text = fs.readFileSync(toolFile(), "utf8")
    const records = text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ tool: "bash", status: "completed", durationMs: 450, tick: null, stepId: null })
    expect(records[0].argsSummary.length).toBe(ARGS_SUMMARY_MAX + 1)
    expect(text).not.toContain("SECRET_TOOL_OUTPUT")
  })

  it("does NOT append for a non-terminal tool state", async () => {
    const command = Command.make("bash", "-c", `printf '%s\\n' '${toolLine("running")}'`)
    await Effect.runPromise(
      Effect.provide(
        runTransport({ command, normalize: normalizeOpenCode, runtimeTag: "opencode", char, role: "body", timeoutMs: 5000 }),
        deps,
      ),
    )
    expect(fs.existsSync(toolFile())).toBe(false)
  })

  it('appends an episode for an ERRORED tool call (status "error")', async () => {
    const command = Command.make("bash", "-c", `printf '%s\\n' '${toolLine("error")}'`)
    await Effect.runPromise(
      Effect.provide(
        runTransport({ command, normalize: normalizeOpenCode, runtimeTag: "opencode", char, role: "body", timeoutMs: 5000 }),
        deps,
      ),
    )
    const text = fs.readFileSync(toolFile(), "utf8")
    const records = text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ tool: "bash", status: "error", durationMs: 450 })
    expect(text).not.toContain("SECRET_TOOL_OUTPUT")
  })
})
