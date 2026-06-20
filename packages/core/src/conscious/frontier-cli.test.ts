import { describe, it, expect } from "vitest"
import {
  buildFrontierWorkerFlags,
  buildFrontierCliScript,
  FRONTIER_CLI_PATH,
  FRONTIER_RUN_DIR,
} from "./frontier-cli.js"
import { taskLine, steerLine, endLine } from "../core/limbic/hypothalamus/sdk-payload.js"

describe("buildFrontierWorkerFlags", () => {
  const flags = buildFrontierWorkerFlags("sonnet")
  it("reuses the claude base flags (no --bare)", () => {
    expect(flags).toContain("-p")
    expect(flags).toContain("--permission-mode bypassPermissions")
    expect(flags).toContain("--model sonnet")
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
  it("embeds the worker invocation flags", () => {
    expect(script).toContain(buildFrontierWorkerFlags("sonnet"))
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
})
