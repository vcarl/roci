import { describe, it, expect } from "vitest"
import { Effect, Layer, Stream } from "effect"
import { CommandExecutor } from "@effect/platform"
import { buildExecArgs, runTurn } from "./process-runner.js"
import { buildInnerCommand } from "./payload.js"
import type { TurnConfig } from "./types.js"
import { CharacterLog } from "../../logging/log-writer.js"
import { OAuthToken } from "../../services/OAuthToken.js"
import type { UnifiedEvent } from "../../logging/events.js"

const base: TurnConfig = {
  containerId: "cabc",
  playerName: "ada",
  systemPrompt: "be good",
  prompt: "do it",
  model: "opus",
  timeoutMs: 1000,
  char: { name: "ada", dir: "/work/players/ada/me" },
  role: "body",
}

describe("buildExecArgs", () => {
  const args = buildExecArgs(base, "claude -p --model opus", "tok123")

  it("scopes the working directory to the player", () => {
    const i = args.indexOf("-w")
    expect(args[i + 1]).toBe("/work/players/ada")
  })
  it("injects the OAuth token as an env var", () => {
    expect(args).toContain("-e")
    expect(args).toContain("CLAUDE_CODE_OAUTH_TOKEN=tok123")
  })
  it("ends with containerId, bash -c, and the inner command", () => {
    expect(args.slice(-4)).toEqual(["cabc", "bash", "-c", "claude -p --model opus"])
  })
  it("starts with exec -i", () => {
    expect(args.slice(0, 2)).toEqual(["exec", "-i"])
  })
  it("passes custom env but never re-passes the OAuth key", () => {
    const withEnv = buildExecArgs(
      { ...base, env: { FOO: "bar", CLAUDE_CODE_OAUTH_TOKEN: "should-be-ignored" } },
      "claude -p",
      "realtok",
    )
    expect(withEnv).toContain("FOO=bar")
    expect(withEnv).toContain("CLAUDE_CODE_OAUTH_TOKEN=realtok")
    expect(withEnv).not.toContain("CLAUDE_CODE_OAUTH_TOKEN=should-be-ignored")
  })

  it("retained claude -p capability: a claude-model turn still builds a claude -p payload", () => {
    // Proves the dormant raw `claude -p` path remains wired through the shared
    // transport even though the SDK runner (Phase 2) becomes the frontier default.
    const inner = buildInnerCommand(base, "claude")
    expect(inner.startsWith("claude -p")).toBe(true)
    const full = buildExecArgs(base, inner, "tok")
    expect(full[full.length - 1]).toBe(inner)
  })
})

// Fake process for stubbing CommandExecutor: zero output, immediate exit code 0.
const fakeProcess = {
  exitCode: Effect.succeed(0),
  isRunning: Effect.succeed(false),
  kill: () => Effect.void,
  stderr: Stream.empty,
  stdout: Stream.empty,
  toJSON: () => ({}),
  toString: () => "FakeProcess",
} as unknown as CommandExecutor.Process

// Stub executor: always returns fakeProcess; never actually runs docker.
const StubExecutor = Layer.succeed(
  CommandExecutor.CommandExecutor,
  CommandExecutor.makeExecutor((_cmd) => Effect.succeed(fakeProcess) as never),
)

// Stub OAuthToken: returns a fixed token without any filesystem access.
const StubOAuthToken = Layer.succeed(
  OAuthToken,
  OAuthToken.of({
    getToken: Effect.succeed({ token: "stub-token", version: 0 }),
    validateInContainer: () => Effect.succeed(true),
  }),
)

describe("runTurn body exchange", () => {
  it("emits a body exchange carrying the full task prompt", async () => {
    const emitted: UnifiedEvent[] = []
    const CapturingLog = Layer.succeed(
      CharacterLog,
      CharacterLog.of({
        emit: (_char, event) => Effect.sync(() => { emitted.push(event) }),
      }),
    )
    const deps = Layer.mergeAll(CapturingLog, StubExecutor, StubOAuthToken)

    await Effect.runPromise(
      Effect.provide(
        runTurn({ ...base, prompt: "# Task: do the thing" }),
        deps,
      ),
    )

    const ex = emitted.find((e) => e.kind === "exchange") as Extract<UnifiedEvent, { kind: "exchange" }> | undefined
    expect(ex).toBeDefined()
    expect(ex!.channel).toBe("body")
    expect(ex!.prompt).toContain("# Task: do the thing")
  })
})
