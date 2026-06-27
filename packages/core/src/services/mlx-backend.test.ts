import { describe, it, expect } from "vitest"
import { Cause, Effect, Exit, Option } from "effect"
import { NodeContext } from "@effect/platform-node"
import * as path from "node:path"
import {
  buildMlxArgs,
  buildProbeRequest,
  makeMlxBackend,
  resolveMlxCommand,
  mlxNotFoundMessage,
  MLX_SERVER_BIN,
} from "./mlx-backend.js"
import { resolveTierSpec } from "./model-tier-spec.js"
import { ReadinessError } from "./model-backend.js"

// resolveMlxCommand is a pure helper: it decides WHICH mlx_lm.server binary to
// spawn from an injected env + homedir + existence check, so it is unit-testable
// without spawning a real process or touching the real filesystem. These tests
// pin the four resolution outcomes the default spawn seam relies on.
describe("resolveMlxCommand", () => {
  const home = "/home/tester"

  it("returns the absolute venv binary and a PATH prepend when the venv binary exists", () => {
    const binDir = path.join(home, "llm-env", "bin")
    const venvBin = path.join(binDir, "mlx_lm.server")
    const res = resolveMlxCommand({ PATH: "/usr/bin" }, home, (p) => p === venvBin)
    expect(res.found).toBe(true)
    if (res.found) {
      expect(res.command).toBe(venvBin)
      // The PATH prepend must include <venv>/bin so the server's own child
      // resolution works even without an activated shell.
      expect(res.pathPrepend).toBe(binDir)
    }
  })

  it("uses the ROCI_LLM_ENV override root when set", () => {
    const root = "/opt/custom-venv"
    const binDir = path.join(root, "bin")
    const venvBin = path.join(binDir, "mlx_lm.server")
    const res = resolveMlxCommand(
      { ROCI_LLM_ENV: root, PATH: "/usr/bin" },
      home,
      (p) => p === venvBin,
    )
    expect(res.found).toBe(true)
    if (res.found) {
      expect(res.command).toBe(venvBin)
      expect(res.pathPrepend).toBe(binDir)
    }
  })

  it("falls back to the bare command when no venv binary but it is resolvable on PATH", () => {
    const onPath = "/usr/local/bin/mlx_lm.server"
    const res = resolveMlxCommand({ PATH: "/usr/local/bin" }, home, (p) => p === onPath)
    expect(res.found).toBe(true)
    if (res.found) {
      expect(res.command).toBe(MLX_SERVER_BIN)
      // No venv was used, so there is nothing to prepend.
      expect(res.pathPrepend).toBeUndefined()
    }
  })

  it("reports not-found (with the searched bin dir) when neither venv nor PATH has it", () => {
    const res = resolveMlxCommand({ PATH: "/usr/bin" }, home, () => false)
    expect(res.found).toBe(false)
    if (!res.found) {
      expect(res.searchedBinDir).toBe(path.join(home, "llm-env", "bin"))
    }
  })
})

// The missing-runtime error is the message that surfaces when a model is spawned
// without a reachable runtime, so it must be actionable: name the activation
// hint, the env-var override, and the install hint.
describe("mlxNotFoundMessage", () => {
  it("includes the activation hint, the env-var name, and the pip install hint", () => {
    const msg = mlxNotFoundMessage("/home/tester/llm-env/bin")
    expect(msg).toContain("source ~/llm-env/bin/activate")
    expect(msg).toContain("ROCI_LLM_ENV")
    expect(msg).toContain("pip install mlx-lm")
    expect(msg).toContain("/home/tester/llm-env/bin")
  })
})

describe("buildMlxArgs", () => {
  it("builds mlx_lm.server --model <id> --port <p> for the conscious tier", () => {
    const args = buildMlxArgs(resolveTierSpec("conscious"))
    expect(args).toEqual([
      "--model", "mlx-community/Qwen3.5-122B-A10B-4bit",
      "--port", "8083",
    ])
  })
  it("appends spawnArgs after the base flags", () => {
    const spec = { ...resolveTierSpec("hindbrain"), spawnArgs: ["--trust-remote-code"] as const }
    expect(buildMlxArgs(spec)).toEqual([
      "--model", "mlx-community/Qwen3.5-2B-4bit",
      "--port", "8081",
      "--trust-remote-code",
    ])
  })
})

describe("buildProbeRequest", () => {
  it("targets /chat/completions with a 1-token generate (NOT /v1/models)", () => {
    const { url, body } = buildProbeRequest(resolveTierSpec("forebrain"))
    expect(url).toBe("http://127.0.0.1:8082/v1/chat/completions")
    expect(url).not.toContain("/models")
    expect(body.max_tokens).toBe(1)
    expect(body.model).toBe("mlx-community/Qwen3.5-9B-4bit")
    expect(body.stream).toBe(false)
  })
})

// A 2xx is NOT proof of readiness: mlx_lm.server can answer with a DIFFERENT
// model than we asked it to load (wrong --model, a stale server already bound to
// the port, etc.). The readiness gate must verify the model the server echoes in
// the chat/completions response matches the model we expect, or a wrong-model
// spawn ships silently. These tests drive readinessProbe through a fake fetch so
// they never spawn a real server.
describe("readinessProbe — model identity verification", () => {
  const spec = resolveTierSpec("hindbrain") // expects mlx-community/Qwen3.5-2B-4bit

  const fetchReturning = (status: number, payload: unknown): typeof fetch =>
    (async () =>
      ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
      }) as unknown as Response) as unknown as typeof fetch

  // A 2xx whose body cannot be parsed as JSON (json() rejects) — e.g. a proxy
  // error page or a truncated stream. Must be "not ready", never a crash.
  const fetchWithNonJsonBody = (status: number): typeof fetch =>
    (async () =>
      ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON at position 0")
        },
      }) as unknown as Response) as unknown as typeof fetch

  const runProbe = (fetchImpl: typeof fetch) =>
    Effect.runPromiseExit(
      makeMlxBackend({ fetchImpl })
        .pipe(Effect.flatMap((b) => b.readinessProbe(spec)))
        .pipe(Effect.provide(NodeContext.layer)),
    )

  it("succeeds when the response echoes the expected model id", async () => {
    const exit = await runProbe(
      fetchReturning(200, { model: spec.model, choices: [{ message: { content: "ok" } }] }),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it("fails with a ReadinessError naming expected vs actual on a model mismatch", async () => {
    const exit = await runProbe(
      fetchReturning(200, { model: "mlx-community/SomeOtherModel-4bit", choices: [] }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const failure = Exit.isFailure(exit)
      ? Option.getOrUndefined(Cause.failureOption(exit.cause))
      : undefined
    expect(failure).toBeInstanceOf(ReadinessError)
    // The ReadinessError must name both the expected and the actual model so the
    // operator can see exactly what went wrong.
    expect((failure as ReadinessError).message).toContain(spec.model)
    expect((failure as ReadinessError).message).toContain("mlx-community/SomeOtherModel-4bit")
  })

  it("treats a 2xx response with no model field as NOT ready (does not crash)", async () => {
    const exit = await runProbe(fetchReturning(200, { choices: [{ message: { content: "ok" } }] }))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails readiness on a non-2xx response", async () => {
    const exit = await runProbe(fetchReturning(503, { error: "loading" }))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("treats a 2xx response with an empty-string model as NOT ready (does not crash)", async () => {
    const exit = await runProbe(
      fetchReturning(200, { model: "", choices: [{ message: { content: "ok" } }] }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("treats a 2xx response with a non-string model as NOT ready (does not crash)", async () => {
    const exit = await runProbe(
      fetchReturning(200, { model: 123, choices: [{ message: { content: "ok" } }] }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("treats a 2xx response with a non-JSON body as NOT ready (does not crash)", async () => {
    const exit = await runProbe(fetchWithNonJsonBody(200))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
