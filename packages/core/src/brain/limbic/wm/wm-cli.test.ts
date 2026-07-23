import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { Docker } from "../../../services/Docker.js"
import { WM_CLI_PATH, provisionWmCli } from "./wm-cli.js"

// The `wm` CLI's behavior is tested where it now lives — @roci/player-tools
// (wm-run/wm-core suites) — and its container parity is captured in
// docs/superpowers/specs/phase3-gate-evidence.md. Core keeps only the host-side
// provisioning contract.
describe("provisionWmCli", () => {
  it("execs AS ROOT a command that base64-writes the bundle to /usr/local/bin/wm and chmods it", async () => {
    const calls: Array<{ command: string[]; opts?: { user?: string } }> = []
    const StubDocker = Layer.succeed(
      Docker,
      Docker.of({
        exec: (_id: string, command: string[], opts?: { user?: string }) => {
          calls.push({ command, opts })
          return Effect.succeed("")
        },
      } as unknown as typeof Docker.Service),
    )
    await Effect.runPromise(Effect.provide(provisionWmCli("c1"), StubDocker))
    expect(calls).toHaveLength(1)
    expect(calls[0].opts?.user).toBe("root")
    const sh = calls[0].command.join(" ")
    expect(sh).toContain(WM_CLI_PATH)
    expect(sh).toContain("chmod 0755")
  })
})
