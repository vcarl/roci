import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { provisionMemoryCli, MEMORY_CLI_PATH } from "./memory-cli.js"
import { Docker } from "../../../../services/Docker.js"
import { readPlayerToolBundle } from "../../../../services/player-tools-bundle.js"

// The `memory` CLI's behavior is tested where it now lives — @roci/player-tools
// (memory-run/command-codec/memory-format/... suites) — and its byte-for-byte
// container parity is captured in docs/superpowers/specs/phase3-gate-evidence.md.
// Core keeps only the host-side provisioning contract.
describe("provisionMemoryCli", () => {
  it("execs AS ROOT a command that base64-writes the BUNDLE ARTIFACT to the CLI path and chmods it", async () => {
    const calls: { command: string[]; opts?: { user?: string } }[] = []
    const StubDocker = Layer.succeed(
      Docker,
      Docker.of({
        exec: (_id: string, command: string[], execOpts?: { user?: string }) => {
          calls.push({ command, opts: execOpts })
          return Effect.succeed("")
        },
      } as unknown as typeof Docker.Service),
    )
    await Effect.runPromise(Effect.provide(provisionMemoryCli("cabc"), StubDocker))
    const joined = calls.flatMap((c) => c.command).join(" ")
    expect(joined).toContain(MEMORY_CLI_PATH)
    expect(joined).toContain("base64 -d")
    expect(joined).toContain("chmod 0755")
    // The installed payload is the built @roci/player-tools bundle VERBATIM (the
    // shipped code IS the tested code), not a host-generated string.
    const b64 = Buffer.from(readPlayerToolBundle("memory")).toString("base64")
    expect(joined).toContain(b64)
    // Must run as root: /usr/local/bin is root-owned, the container's default user
    // is `node`, so provisioning as node hits Permission denied (the QA blocker).
    expect(calls[0].opts?.user).toBe("root")
  })

  it("PROPAGATES a Docker failure (no longer swallows — provisionImpl logs it loud)", async () => {
    const FailDocker = Layer.succeed(
      Docker,
      Docker.of({
        exec: () => Effect.fail(new Error("docker boom")),
      } as unknown as typeof Docker.Service),
    )
    // The error now reaches the caller (provisionImpl), which logs loud + continues.
    await expect(
      Effect.runPromise(Effect.provide(provisionMemoryCli("cabc"), FailDocker)),
    ).rejects.toThrow()
  })
})
