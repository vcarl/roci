import { describe, it, expect } from "vitest"
import { Effect, Layer, Stream } from "effect"
import { Command } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import { buildExecArgs, runSdkTurn, runSdkSession, runOpenCodeSessionTurn, firstSessionId, sessionNotFoundMessage } from "./process-runner.js"
import { buildInnerCommand, openCodeBodyEnv } from "./payload.js"
import type { TurnConfig } from "./types.js"
import { runTransport } from "./transport.js"
import { normalizeSdk } from "../../../logging/stream-normalizer.js"
import { buildSdkStdin, taskLine, steerLine, endLine } from "./sdk-payload.js"
import { CharacterLog } from "../../../logging/log-writer.js"

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

const StubCharacterLog = Layer.succeed(CharacterLog, CharacterLog.of({ emit: () => Effect.void }))
const sdkDeps = Layer.merge(NodeContext.layer, StubCharacterLog)
const char = { name: "ada", dir: "/work/players/ada/me" }

describe("SDK payload over the transport (run-to-completion)", () => {
  it("accumulates assistant text from a fake runner emitting SDK NDJSON", async () => {
    // A fake runner: echoes two event lines (assistant text) then a result line.
    const ev1 = JSON.stringify({ v: 1, type: "event", event: { type: "assistant", message: { content: [{ type: "text", text: "part1" }] } } })
    const ev2 = JSON.stringify({ v: 1, type: "event", event: { type: "assistant", message: { content: [{ type: "text", text: "part2" }] } } })
    const res = JSON.stringify({ v: 1, type: "result", status: "completed", output: "part1\npart2" })
    const script = `printf '%s\\n%s\\n%s\\n' '${ev1}' '${ev2}' '${res}'`
    const command = Command.make("bash", "-c", script)

    const result = await Effect.runPromise(
      Effect.provide(
        runTransport({ command, normalize: normalizeSdk, runtimeTag: "sdk", char, role: "body", timeoutMs: 5000 }),
        sdkDeps,
      ),
    )
    expect(result.timedOut).toBe(false)
    expect(result.output).toBe("part1\npart2")
  }, 10000)

  it("buildSdkStdin feeds a runner that reads it (round-trip through stdin)", async () => {
    // Prove the NDJSON stdin is consumable: a fake runner reads stdin and echoes
    // an assistant event carrying the task text back.
    const stdin = Stream.encodeText(Stream.make(buildSdkStdin("echo me")))
    const script = `node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const first=JSON.parse(d.split("\\n")[0]);console.log(JSON.stringify({v:1,type:"event",event:{type:"assistant",message:{content:[{type:"text",text:first.text}]}}}));})'`
    const command = Command.make("bash", "-c", script).pipe(Command.stdin(stdin))

    const result = await Effect.runPromise(
      Effect.provide(
        runTransport({ command, normalize: normalizeSdk, runtimeTag: "sdk", char, role: "body", timeoutMs: 5000 }),
        sdkDeps,
      ),
    )
    expect(result.output).toBe("echo me")
  }, 10000)
})

describe("runSdkTurn", () => {
  it("is exported as a function with the runTurn-style signature", () => {
    expect(typeof runSdkTurn).toBe("function")
  })
})

describe("runSdkSession", () => {
  it("is exported as a function", () => {
    expect(typeof runSdkSession).toBe("function")
  })

  it("delivers task + steer lines from a static steered stdin and accumulates both turns", async () => {
    // runSdkSession hardcodes Command.make("docker", …) so it cannot run host-side;
    // prove the seam (steered stdin → transport → normalizeSdk) via runTransport with
    // a fake runner, exactly as the Phase-2 composition tests do. The stdin here is a
    // STATIC task+steer+end stream (the live queue→stream mapping is covered in Task 2).
    const stdinText = `${taskLine("do the thing")}\n${steerLine("now do the other thing")}\n${endLine()}\n`
    const stdin = Stream.encodeText(Stream.make(stdinText))
    // Fake runner: read every stdin line; echo each task/steer line's text as an
    // assistant event; emit a terminal result on stdin EOF.
    const script =
      `node -e 'const rl=require("readline").createInterface({input:process.stdin});` +
      `rl.on("line",l=>{try{const o=JSON.parse(l);if(o.type==="task"||o.type==="steer")` +
      `process.stdout.write(JSON.stringify({v:1,type:"event",event:{type:"assistant",message:{content:[{type:"text",text:o.text}]}}})+"\\n")}catch{}});` +
      `rl.on("close",()=>process.stdout.write(JSON.stringify({v:1,type:"result",status:"completed",output:"done"})+"\\n"))'`
    const command = Command.make("bash", "-c", script).pipe(Command.stdin(stdin))

    const result = await Effect.runPromise(
      Effect.provide(
        runTransport({ command, normalize: normalizeSdk, runtimeTag: "sdk", char, role: "body", timeoutMs: 5000 }),
        sdkDeps,
      ),
    )
    expect(result.timedOut).toBe(false)
    expect(result.output).toBe("do the thing\nnow do the other thing")
  }, 10000)
})

describe("firstSessionId", () => {
  it("returns the sessionID string when present", () => {
    expect(firstSessionId({ type: "step_start", sessionID: "ses_xyz" })).toBe("ses_xyz")
  })
  it("returns null when absent or non-string", () => {
    expect(firstSessionId({ type: "text" })).toBeNull()
    expect(firstSessionId({ sessionID: 123 })).toBeNull()
  })
})

describe("runOpenCodeSessionTurn", () => {
  it("is exported as a function", () => {
    expect(typeof runOpenCodeSessionTurn).toBe("function")
  })

  it("the opencode body exec env disables the blocked models.dev fetch and autoupdate (as -e flags)", () => {
    // The opencode body invocation runs inside a network-locked container; if it
    // tries to fetch https://models.dev/api.json it hangs. buildExecArgs must emit
    // OPENCODE_DISABLE_MODELS_FETCH=1 and OPENCODE_DISABLE_AUTOUPDATE=1 as -e flags
    // so opencode skips the fetch and uses the configured local provider.
    const cfg: TurnConfig = { ...base, model: "local/conscious", agentName: "conscious" }
    const args = buildExecArgs({ ...cfg, env: openCodeBodyEnv(cfg) }, "opencode run --format json", "tok")
    const flags = args.filter((_, i) => args[i - 1] === "-e")
    expect(flags).toContain("OPENCODE_DISABLE_MODELS_FETCH=1")
    expect(flags).toContain("OPENCODE_DISABLE_AUTOUPDATE=1")
  })
})

describe("sessionNotFoundMessage", () => {
  it("first-turn message (no resume) matches the original wording", () => {
    expect(sessionNotFoundMessage()).toBe("OpenCode session id not captured from run output")
  })
  it("resume-path message names the resume and the session id, and differs from the first-turn message", () => {
    const msg = sessionNotFoundMessage({ sessionId: "ses_abc" })
    expect(msg).toContain("resume")
    expect(msg).toContain("ses_abc")
    expect(msg).not.toBe(sessionNotFoundMessage())
  })
})
