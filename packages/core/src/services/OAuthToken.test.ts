import { describe, it, expect } from "vitest"
import { classifyValidationResult } from "./OAuthToken.js"

describe("classifyValidationResult", () => {
  it("reports valid on a clean exit 0", () => {
    const out = classifyValidationResult(
      { ok: true, status: 0, stdout: "Pong!", stderr: "" },
      { containerRunning: true },
    )
    expect(out.kind).toBe("valid")
  })

  it("treats a rate-limit response as valid (auth succeeded, just throttled)", () => {
    const out = classifyValidationResult(
      { ok: false, status: 1, stdout: "You've hit your usage limit; resets at 5pm", stderr: "" },
      { containerRunning: true },
    )
    expect(out.kind).toBe("rate-limited")
  })

  it("classifies exit 137 (SIGKILL) as container-unavailable, not auth-rejected", () => {
    // This is the exact Bug A scenario: firewall killed the container, so the
    // `docker exec` died with 137. The token is fine.
    const out = classifyValidationResult(
      { ok: false, status: 137, stdout: "", stderr: "" },
      { containerRunning: false },
    )
    expect(out.kind).toBe("container-unavailable")
  })

  it("classifies a not-running container as container-unavailable even with exit 1", () => {
    const out = classifyValidationResult(
      {
        ok: false,
        status: 1,
        stdout: "",
        stderr: "Error response from daemon: container abc123 is not running",
      },
      { containerRunning: false },
    )
    expect(out.kind).toBe("container-unavailable")
  })

  it("classifies a no-such-container exec failure as container-unavailable", () => {
    const out = classifyValidationResult(
      {
        ok: false,
        status: null,
        stdout: "",
        stderr: "Error: No such container: abc123",
      },
      { containerRunning: false },
    )
    expect(out.kind).toBe("container-unavailable")
  })

  it("classifies a genuine auth rejection as auth-rejected", () => {
    const out = classifyValidationResult(
      {
        ok: false,
        status: 1,
        stdout: "",
        stderr: "Invalid API key · Please run /login (OAuth token is not valid)",
      },
      { containerRunning: true },
    )
    expect(out.kind).toBe("auth-rejected")
  })

  it("treats any signal-style exit (>128) on a dead container as container-unavailable", () => {
    const out = classifyValidationResult(
      { ok: false, status: 143, stdout: "", stderr: "" },
      { containerRunning: false },
    )
    expect(out.kind).toBe("container-unavailable")
  })
})
