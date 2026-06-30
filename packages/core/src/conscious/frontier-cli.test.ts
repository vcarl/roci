import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import {
  buildFrontierWorkerFlags,
  buildFrontierCliScript,
  FRONTIER_CLI_PATH,
  FRONTIER_RUN_DIR,
  provisionFrontierCli,
} from "./frontier-cli.js"
import { taskLine, steerLine, endLine } from "../core/limbic/hypothalamus/sdk-payload.js"
import { Docker } from "../services/Docker.js"

describe("buildFrontierWorkerFlags", () => {
  const flags = buildFrontierWorkerFlags()
  it("reuses the claude base flags but NOT a baked --model (model is runtime-variable)", () => {
    expect(flags).toContain("-p")
    expect(flags).toContain("--permission-mode bypassPermissions")
    expect(flags).not.toContain("--model")
    expect(flags).not.toContain("--bare")
  })
  it("runs in streaming-input + streaming-output json mode", () => {
    expect(flags).toContain("--input-format stream-json")
    expect(flags).toContain("--output-format stream-json")
    expect(flags).toContain("--verbose")
  })
})

describe("buildFrontierCliScript", () => {
  const script = buildFrontierCliScript({ model: "sonnet", timeoutMs: 600000 })
  it("dispatches the four subcommands", () => {
    expect(script).toContain('start)')
    expect(script).toContain('poll)')
    expect(script).toContain('steer)')
    expect(script).toContain('wait)')
  })
  it("backs handle state in a per-id run dir under the run root", () => {
    expect(script).toContain(FRONTIER_RUN_DIR)
    expect(script).toContain("mkfifo")
    expect(script).toContain("in.fifo")
    expect(script).toContain("out")
  })
  it("detaches the worker so a later turn can reattach", () => {
    // setsid or nohup — detached + file-backed by handle id
    expect(script).toMatch(/setsid|nohup/)
  })
  it("embeds the static worker invocation flags (no baked --model)", () => {
    expect(script).toContain(buildFrontierWorkerFlags())
  })
  it("bakes the provided default model and selects it at runtime via FRONTIER_MODEL", () => {
    expect(script).toContain('DEFAULT_MODEL="sonnet"')
    expect(script).toContain('--model "$FRONTIER_MODEL"')
    expect(script).toContain('FRONTIER_MODEL=')
  })
  it("start parses an optional --model override, defaulting to DEFAULT_MODEL", () => {
    expect(script).toContain('--model)')
    expect(script).toContain('override="${override:-$DEFAULT_MODEL}"')
  })
  it("frames start as a task line and wait as an end line via the shared builders", () => {
    // start writes taskLine(task); wait appends endLine()
    expect(script).toContain('"type":"task"')
    expect(script).toContain('"type":"steer"')
    expect(script).toContain('"type":"end"')
    // shared builder shapes (laundering note: $1/$2 are model-authored args, never raw events)
    expect(endLine()).toBe('{"v":1,"type":"end"}')
    expect(taskLine("X")).toContain('"type":"task"')
    expect(steerLine("X")).toContain('"type":"steer"')
  })
  it("prints a trailing status line on poll and wait", () => {
    expect(script).toMatch(/status:/)
  })
  it("bakes the wall-clock budget from timeoutMs (no new knob)", () => {
    expect(script).toContain("600000")
  })
  it("stream-json extractor walks message.content[] for type:text items (shape 3)", () => {
    // The old two-path extractor only checked o.get("text") and o.get("message").get("text").
    // The real claude stream-json assistant frame nests text under message.content[].
    // These assertions FAIL on the old extractor (no "content" path) but PASS on the new one.
    // The script string contains bash-level escaping: \" appears as \\"  in the TS string.
    expect(script).toContain('.get(\\"content\\")')
    expect(script).toContain('i.get(\\"type\\")==\\"text\\"')
  })
})

describe("provisionFrontierCli", () => {
  it("execs AS ROOT a command that base64-writes the script to the CLI path and chmods it executable", async () => {
    const calls: { command: string[]; user?: string }[] = []
    const StubDocker = Layer.succeed(
      Docker,
      Docker.of({
        exec: (_id: string, command: string[], execOpts?: { user?: string }) => {
          calls.push({ command, user: execOpts?.user })
          return Effect.succeed("")
        },
      } as unknown as typeof Docker.Service),
    )
    await Effect.runPromise(
      Effect.provide(provisionFrontierCli("cabc", { model: "sonnet", timeoutMs: 600000 }), StubDocker),
    )
    const joined = calls.flatMap((c) => c.command).join(" ")
    expect(joined).toContain(FRONTIER_CLI_PATH)
    expect(joined).toContain("base64 -d")
    expect(joined).toContain("chmod 0755")
    const b64 = Buffer.from(buildFrontierCliScript({ model: "sonnet", timeoutMs: 600000 })).toString("base64")
    expect(joined).toContain(b64)
    // Must run as root: /usr/local/bin is root-owned, container default user is node.
    expect(calls[0].user).toBe("root")
  })
})
