import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { Command } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import { runTransport, parseStreamJson, isAuthError } from "./transport.js"
import { normalizeClaude, normalizeOpenCode } from "../../../logging/stream-normalizer.js"
import { CharacterLog } from "../../../logging/log-writer.js"

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
