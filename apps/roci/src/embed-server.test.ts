import { describe, it, expect, vi, beforeEach } from "vitest"
import { Effect, Layer } from "effect"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import {
  EMBED_PORT,
  EMBED_MODEL,
  EMBED_PYTHON_BIN,
  embedServerScriptPath,
  embedHealthUrl,
  resolveEmbedPython,
  embedPythonNotFoundMessage,
  buildEmbedServerSpawn,
  launchEmbedServer,
  registerEmbedServer,
  unregisterEmbedServer,
  reapEmbedServers,
  _embedServerPids,
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
})

// resolveEmbedPython mirrors resolveMlxCommand: it decides WHICH python the embed
// server is spawned with from an injected env + homedir + existence check, so a
// normal `roci start` brings the server up against the model venv with no manual
// `source activate`. These pin the four resolution outcomes.
describe("resolveEmbedPython", () => {
  const home = "/home/tester"

  it("uses an explicit ROCI_EMBED_PYTHON override verbatim, with no PATH prepend", () => {
    const res = resolveEmbedPython(
      { ROCI_EMBED_PYTHON: "/custom/python", PATH: "/usr/bin" },
      home,
      () => true,
    )
    expect(res.found).toBe(true)
    if (res.found) {
      expect(res.command).toBe("/custom/python")
      expect(res.pathPrepend).toBeUndefined()
    }
  })

  it("treats an empty ROCI_EMBED_PYTHON as unset and falls through to the venv", () => {
    const binDir = path.join(home, "llm-env", "bin")
    const venvPython = path.join(binDir, EMBED_PYTHON_BIN)
    const res = resolveEmbedPython(
      { ROCI_EMBED_PYTHON: "", PATH: "/usr/bin" },
      home,
      (p) => p === venvPython,
    )
    expect(res.found).toBe(true)
    if (res.found) {
      expect(res.command).toBe(venvPython)
      expect(res.pathPrepend).toBe(binDir)
    }
  })

  it("resolves the venv python (absolute) and prepends <venv>/bin when it exists", () => {
    const binDir = path.join(home, "llm-env", "bin")
    const venvPython = path.join(binDir, EMBED_PYTHON_BIN)
    const res = resolveEmbedPython({ PATH: "/usr/bin" }, home, (p) => p === venvPython)
    expect(res.found).toBe(true)
    if (res.found) {
      expect(res.command).toBe(venvPython)
      expect(res.pathPrepend).toBe(binDir)
    }
  })

  it("honours ROCI_LLM_ENV when resolving the venv root", () => {
    const root = "/opt/custom-venv"
    const binDir = path.join(root, "bin")
    const venvPython = path.join(binDir, EMBED_PYTHON_BIN)
    const res = resolveEmbedPython(
      { ROCI_LLM_ENV: root, PATH: "/usr/bin" },
      home,
      (p) => p === venvPython,
    )
    expect(res.found).toBe(true)
    if (res.found) {
      expect(res.command).toBe(venvPython)
      expect(res.pathPrepend).toBe(binDir)
    }
  })

  it("falls back to a bare python3 resolvable on PATH (no prepend)", () => {
    const onPath = "/usr/local/bin/python3"
    const res = resolveEmbedPython({ PATH: "/usr/local/bin" }, home, (p) => p === onPath)
    expect(res.found).toBe(true)
    if (res.found) {
      expect(res.command).toBe(EMBED_PYTHON_BIN)
      expect(res.pathPrepend).toBeUndefined()
    }
  })

  it("reports not-found (with the searched bin dir) when neither venv nor PATH has python3", () => {
    const res = resolveEmbedPython({ PATH: "/usr/bin" }, home, () => false)
    expect(res.found).toBe(false)
    if (!res.found) {
      expect(res.searchedBinDir).toBe(path.join(home, "llm-env", "bin"))
    }
  })
})

describe("embedPythonNotFoundMessage", () => {
  it("names the venv location and both override env vars, and is actionable", () => {
    const msg = embedPythonNotFoundMessage("/home/tester/llm-env/bin")
    expect(msg).toContain("/home/tester/llm-env/bin")
    expect(msg).toContain("ROCI_EMBED_PYTHON")
    expect(msg).toContain("ROCI_LLM_ENV")
    expect(msg).toContain("source ~/llm-env/bin/activate")
    expect(msg).toContain("long-term memory")
  })
})

describe("buildEmbedServerSpawn", () => {
  it("builds the spawn spec from a bare-command resolution (no PATH overlay)", () => {
    const spec = buildEmbedServerSpawn("/repo", { found: true, command: "python3" }, "/usr/bin")
    expect(spec.command).toBe("python3")
    expect(spec.args).toEqual(["/repo/scripts/embed-server/serve-embeddings.py"])
    expect(spec.env.EMB_PORT).toBe(String(EMBED_PORT))
    expect(spec.env.EMB_MODEL).toBe(EMBED_MODEL)
    expect(spec.env.PATH).toBeUndefined()
  })

  it("prepends <venv>/bin to PATH when the resolution carries a pathPrepend", () => {
    const spec = buildEmbedServerSpawn(
      "/repo",
      { found: true, command: "/venv/bin/python3", pathPrepend: "/venv/bin" },
      "/usr/bin",
    )
    expect(spec.command).toBe("/venv/bin/python3")
    expect(spec.env.PATH).toBe(`/venv/bin${path.delimiter}/usr/bin`)
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
    await Effect.runPromise(Effect.provide(launchEmbedServer("/definitely/not/a/repo"), layer))
    expect(
      msgs.some((m) => m.message.includes("not found") && m.message.includes("long-term memory")),
    ).toBe(true)
  })

  it("does NOT throw and logs the actionable not-found message when no python resolves", async () => {
    const { layer, msgs } = captureLog()
    // Script present (this repo) but python resolution forced to fail: launch must
    // log the actionable message and continue, never crashing `roci start`. The
    // repo root is derived from this test's location so the script-exists gate
    // passes regardless of the process cwd vitest runs under.
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
    await Effect.runPromise(
      Effect.provide(
        launchEmbedServer(repoRoot, {
          resolvePython: () => ({ found: false, searchedBinDir: "/no/venv/bin" }),
        }),
        layer,
      ),
    )
    expect(
      msgs.some(
        (m) => m.message.includes("/no/venv/bin") && m.message.includes("long-term memory"),
      ),
    ).toBe(true)
  })
})

// The embed server child must NOT keep the parent's event loop referenced (the
// ~2m39s shutdown hang + port-8084 leak): it is spawned detached and `unref()`d,
// then registered with the synchronous reaper that the main.ts signal/exit
// handlers drive — NOT cleaned up by a bare `process.once("exit")`, which could
// never fire because the exit it waited on never arrived.
describe("launchEmbedServer — child is unref'd and registered for reaping", () => {
  const captureLog = () => {
    const layer = Layer.succeed(
      CharacterLog,
      CharacterLog.of({ emit: () => Effect.void }),
    )
    return { layer }
  }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

  beforeEach(() => {
    for (const pid of [..._embedServerPids()]) unregisterEmbedServer(pid)
  })

  it("spawns detached, unref()s the child, and registers its pid with the reaper", async () => {
    const { layer } = captureLog()
    const unref = vi.fn()
    const fakeChild = { pid: 4242, on: vi.fn(), unref }
    const spawnImpl = vi.fn((..._args: unknown[]) => fakeChild as never)
    // Health probe answers ready immediately so the launch returns fast.
    const fetchImpl = (async () => ({ ok: true })) as unknown as typeof fetch

    await Effect.runPromise(
      Effect.provide(
        launchEmbedServer(repoRoot, {
          fetchImpl,
          resolvePython: () => ({ found: true, command: "python3" }),
          spawnImpl: spawnImpl as never,
        }),
        layer,
      ),
    )

    expect(spawnImpl).toHaveBeenCalledTimes(1)
    // Detached so the child is its own process-group leader (group-killable).
    const opts = spawnImpl.mock.calls[0][2] as { detached?: boolean }
    expect(opts.detached).toBe(true)
    // The fix: the child handle is unref'd so it can't pin the event loop open.
    expect(unref).toHaveBeenCalledTimes(1)
    // Registered for the synchronous shutdown reaper.
    expect([..._embedServerPids()]).toContain(4242)
  })
})

// Synchronous orphan-reaper for the embed server child — mirrors the mlx RESIDENT
// reaper (reapResidentServers). The registry is a plain map; the reaper takes an
// injected kill spy so we never touch a real process or real signals.
describe("embed server reaper", () => {
  beforeEach(() => {
    for (const pid of [..._embedServerPids()]) unregisterEmbedServer(pid)
  })

  const makeKillSpy = (goneTargets: ReadonlyArray<number> = []) => {
    const calls: Array<{ target: number; signal: NodeJS.Signals }> = []
    const kill = (target: number, signal: NodeJS.Signals): void => {
      calls.push({ target, signal })
      if (goneTargets.includes(target)) {
        const err = new Error("no such process") as NodeJS.ErrnoException
        err.code = "ESRCH"
        throw err
      }
    }
    return { kill, calls }
  }

  it("registers a pid (with its pgid) and lists it", () => {
    registerEmbedServer(4242, 4242)
    expect([..._embedServerPids()]).toEqual([4242])
  })

  it("removes a pid on unregister; unregistering an unknown pid is a no-op", () => {
    registerEmbedServer(4242, 4242)
    registerEmbedServer(5678, 5678)
    unregisterEmbedServer(4242)
    unregisterEmbedServer(9999)
    expect([..._embedServerPids()]).toEqual([5678])
  })

  it("group-SIGKILLs each tracked child by default and clears the registry", () => {
    registerEmbedServer(4242, 4242)
    registerEmbedServer(5678, 5678)
    const { kill, calls } = makeKillSpy()
    reapEmbedServers(kill)
    // Negative target = the process group; PGID === pid for a detached spawn.
    expect(calls).toEqual([
      { target: -4242, signal: "SIGKILL" },
      { target: -5678, signal: "SIGKILL" },
    ])
    // Cleared so a second call (SIGTERM handler then 'exit' backstop) is a no-op.
    expect([..._embedServerPids()]).toEqual([])
    reapEmbedServers(kill)
    expect(calls).toHaveLength(2)
  })

  it("can reap gracefully with SIGTERM (the Effect shutdown path)", () => {
    registerEmbedServer(4242, 4242)
    const { kill, calls } = makeKillSpy()
    reapEmbedServers(kill, "SIGTERM")
    expect(calls).toEqual([{ target: -4242, signal: "SIGTERM" }])
  })

  it("swallows ESRCH (already gone) and keeps reaping the rest", () => {
    registerEmbedServer(4242, 4242)
    registerEmbedServer(5678, 5678)
    const { kill, calls } = makeKillSpy([-4242]) // first target already gone
    expect(() => reapEmbedServers(kill)).not.toThrow()
    expect(calls.map((c) => c.target)).toEqual([-4242, -5678])
    expect([..._embedServerPids()]).toEqual([])
  })
})
