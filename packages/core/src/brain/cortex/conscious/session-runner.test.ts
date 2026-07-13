import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import { NodeContext } from "@effect/platform-node"
import {
  runOpenCodeSessionTurn,
  firstSessionId,
  sessionNotFoundMessage,
  killWedgedInContainerTurn,
  MAX_SILENCE_ATTEMPTS,
} from "./session-runner.js"
import { buildExecArgs } from "#brain/stem/transport/process-runner.js"
import { openCodeBodyEnv } from "#brain/stem/transport/payload.js"
import type { TurnConfig } from "#brain/stem/transport/types.js"

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

describe("silence recovery", () => {
  it("retries exactly once before aborting (attempt cap = 2)", () => {
    expect(MAX_SILENCE_ATTEMPTS).toBe(2)
  })

  it("killWedgedInContainerTurn is best-effort — never fails even when docker errors", async () => {
    // No such container (and docker may be absent): the kill either exits non-zero
    // or fails to spawn. Either way the effect swallows it and returns void, so a
    // reap failure degrades to a plain retry/abort rather than crashing the turn.
    await Effect.runPromise(
      Effect.provide(
        killWedgedInContainerTurn("no-such-container-xyz", "ada"),
        NodeContext.layer,
      ),
    )
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
