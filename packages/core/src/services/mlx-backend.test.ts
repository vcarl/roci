import { describe, it, expect } from "vitest"
import { Cause, Effect, Exit, Option } from "effect"
import { NodeContext } from "@effect/platform-node"
import { buildMlxArgs, buildProbeRequest, makeMlxBackend } from "./mlx-backend.js"
import { resolveTierSpec } from "./model-tier-spec.js"
import { ReadinessError } from "./model-backend.js"

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
