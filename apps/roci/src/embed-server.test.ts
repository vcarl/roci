import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import {
  EMBED_PORT,
  EMBED_MODEL,
  embedServerScriptPath,
  embedHealthUrl,
  resolveEmbedPython,
  buildEmbedServerSpawn,
  launchEmbedServer,
} from "./embed-server.js"
import { CharacterLog } from "@roci/core/logging/log-writer.js"

describe("embed-server pure helpers", () => {
  it("resolves the standalone server script under scripts/embed-server", () => {
    expect(embedServerScriptPath("/repo")).toBe("/repo/scripts/embed-server/serve-embeddings.py")
  })
  it("builds the health URL on the loopback embed port", () => {
    expect(embedHealthUrl()).toBe(`http://127.0.0.1:${EMBED_PORT}/health`)
    expect(embedHealthUrl(9000)).toBe("http://127.0.0.1:9000/health")
  })
  it("defaults python to python3, honouring ROCI_EMBED_PYTHON", () => {
    expect(resolveEmbedPython({})).toBe("python3")
    expect(resolveEmbedPython({ ROCI_EMBED_PYTHON: "/venv/bin/python" })).toBe("/venv/bin/python")
  })
  it("builds the spawn spec with the script + EMB_PORT/EMB_MODEL env", () => {
    const spec = buildEmbedServerSpawn("/repo", {})
    expect(spec.command).toBe("python3")
    expect(spec.args).toEqual(["/repo/scripts/embed-server/serve-embeddings.py"])
    expect(spec.env.EMB_PORT).toBe(String(EMBED_PORT))
    expect(spec.env.EMB_MODEL).toBe(EMBED_MODEL)
  })
})

describe("launchEmbedServer — resilience", () => {
  const captureLog = () => {
    const msgs: { message: string; level?: string }[] = []
    const layer = Layer.succeed(
      CharacterLog,
      CharacterLog.of({
        emit: (_c, e) =>
          Effect.sync(() => {
            const ev = e as { message?: string; level?: string }
            if (ev.message) msgs.push({ message: ev.message, level: ev.level })
          }),
      }),
    )
    return { layer, msgs }
  }

  it("does NOT throw and logs loud when the server script is missing (graceful degrade)", async () => {
    const { layer, msgs } = captureLog()
    await Effect.runPromise(
      Effect.provide(launchEmbedServer("/definitely/not/a/repo"), layer),
    )
    expect(msgs.some((m) => m.message.includes("not found") && m.message.includes("long-term memory"))).toBe(true)
  })
})
