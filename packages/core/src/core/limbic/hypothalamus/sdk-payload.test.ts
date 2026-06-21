import { describe, it, expect } from "vitest"
import { SDK_RUNNER_PATH, buildSdkInnerCommand, buildSdkStdin, sdkEnv, taskLine, steerLine, endLine } from "./sdk-payload.js"
import type { TurnConfig } from "./types.js"

const base: TurnConfig = {
  containerId: "c1",
  playerName: "ada",
  systemPrompt: "you are an engineer",
  prompt: "fix the bug",
  model: "opus",
  timeoutMs: 1000,
  char: { name: "ada", dir: "/work/players/ada/me" },
  role: "body",
}

describe("buildSdkInnerCommand", () => {
  it("invokes node on the runner with no flags", () => {
    expect(buildSdkInnerCommand()).toBe(`node ${SDK_RUNNER_PATH}`)
  })
})

describe("buildSdkStdin", () => {
  it("emits a task line then an end line, newline-terminated", () => {
    const lines = buildSdkStdin("fix the bug").trimEnd().split("\n")
    expect(JSON.parse(lines[0])).toEqual({ v: 1, type: "task", text: "fix the bug" })
    expect(JSON.parse(lines[1])).toEqual({ v: 1, type: "end" })
  })
  it("safely escapes task text with quotes/newlines", () => {
    const lines = buildSdkStdin('say "hi"\nthen stop').trimEnd().split("\n")
    expect(JSON.parse(lines[0])).toEqual({ v: 1, type: "task", text: 'say "hi"\nthen stop' })
  })
})

describe("NDJSON line builders", () => {
  it("produce the host→runner wire shapes (no trailing newline)", () => {
    expect(JSON.parse(taskLine("do it"))).toEqual({ v: 1, type: "task", text: "do it" })
    expect(JSON.parse(steerLine("redirect"))).toEqual({ v: 1, type: "steer", text: "redirect" })
    expect(JSON.parse(endLine())).toEqual({ v: 1, type: "end" })
  })
})

describe("sdkEnv", () => {
  it("maps config fields to ROCI_SDK_* env and merges config.env", () => {
    const env = sdkEnv({ ...base, env: { FOO: "bar" } })
    expect(env.ROCI_SDK_MODEL).toBe("opus")
    expect(env.ROCI_SDK_SYSTEM_PROMPT).toBe("you are an engineer")
    expect(env.ROCI_SDK_MAX_TURNS).toBe("40")
    expect(env.FOO).toBe("bar")
  })
  it("sets the ROCI_SDK_* keys when config.env is omitted", () => {
    const env = sdkEnv(base)
    expect(env.ROCI_SDK_MODEL).toBe("opus")
    expect(env.ROCI_SDK_SYSTEM_PROMPT).toBe("you are an engineer")
    expect(env.ROCI_SDK_MAX_TURNS).toBe("40")
  })
  it("does not let config.env override the ROCI_SDK_* protocol keys", () => {
    const env = sdkEnv({ ...base, env: { ROCI_SDK_MODEL: "evil", ROCI_SDK_MAX_TURNS: "999" } })
    expect(env.ROCI_SDK_MODEL).toBe("opus")
    expect(env.ROCI_SDK_MAX_TURNS).toBe("40")
  })
})
