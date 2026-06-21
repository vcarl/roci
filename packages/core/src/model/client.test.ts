import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createServer, type Server } from "node:http"
import { Effect, Either, Layer } from "effect"
import { ModelClient, makeModelClient } from "./client.js"
import { ModelError } from "./errors.js"
import type { ModelHandle } from "./handles.js"

// Real-fetch client against the local mock server, but with instant backoff so
// the transient-failure cases below don't pay real retry delays.
const TestClientLive = Layer.succeed(
  ModelClient,
  makeModelClient({ sleep: () => Promise.resolve(), retry: { maxAttempts: 3, baseDelayMs: 0, timeoutMs: 1000 } }),
)

// A mock OpenAI-compatible server whose behavior is switched per-test.
let server: Server
let port: number
let mode:
  | "ok"
  | "500"
  | "garbage"
  | "reasoning-only"
  | "reasoning-content-field"
  | "reasoning-empty-content"
  | "reasoning-and-content"
  | "truly-empty" = "ok"

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end("not found")
      return
    }
    if (mode === "500") {
      res.writeHead(500, { "Content-Type": "text/plain" }).end("model not loaded")
      return
    }
    if (mode === "garbage") {
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"unexpected":true}')
      return
    }
    // A reasoning model that spent its budget thinking: `content` is missing
    // but the answer text lives in `message.reasoning`.
    if (mode === "reasoning-only") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", reasoning: '{"disposition":"discard"}' } }],
          usage: { prompt_tokens: 3, completion_tokens: 7 },
        }),
      )
      return
    }
    // Same, but the field is named `reasoning_content` (vLLM / some MLX builds).
    if (mode === "reasoning-content-field") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", reasoning_content: '{"disposition":"escalate"}' } }],
          usage: { prompt_tokens: 3, completion_tokens: 7 },
        }),
      )
      return
    }
    // `content` is present but an empty string; reasoning has the real text.
    if (mode === "reasoning-empty-content") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          choices: [
            { message: { role: "assistant", content: "", reasoning: '{"disposition":"accumulate"}' } },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 5 },
        }),
      )
      return
    }
    // Both present: `content` must win over `reasoning`.
    if (mode === "reasoning-and-content") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "real-answer", reasoning: "thinking..." } }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }),
      )
      return
    }
    // No usable text anywhere — still a hard error.
    if (mode === "truly-empty") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          choices: [{ message: { role: "assistant" } }],
          usage: { prompt_tokens: 3, completion_tokens: 0 },
        }),
      )
      return
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "pong" } }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as { port: number }).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function handle(p: number): ModelHandle {
  return { tier: "hindbrain", provider: "openai-compatible", baseUrl: `http://127.0.0.1:${p}/v1`, model: "test" }
}

const run = <A, E>(eff: Effect.Effect<A, E, ModelClient>) =>
  Effect.runPromise(Effect.provide(eff, TestClientLive))

describe("ModelClient.complete — auth and params", () => {
  it("sends Authorization header and max_tokens when handle has apiKey and params.maxTokens", async () => {
    let capturedHeaders: Record<string, string> = {}
    let capturedBody: Record<string, unknown> = {}

    const captureServer = createServer((req, res) => {
      capturedHeaders = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v ?? ""]),
      )
      let data = ""
      req.on("data", (chunk: Buffer) => { data += chunk.toString() })
      req.on("end", () => {
        capturedBody = JSON.parse(data) as Record<string, unknown>
        res.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "captured" } }],
            usage: { prompt_tokens: 2, completion_tokens: 1 },
          }),
        )
      })
    })
    await new Promise<void>((resolve) => captureServer.listen(0, "127.0.0.1", resolve))
    const capturePort = (captureServer.address() as { port: number }).port

    const handleWithAuth: ModelHandle = {
      tier: "hindbrain",
      provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${capturePort}/v1`,
      model: "test-model",
      apiKey: "sk-test-key",
      params: { maxTokens: 256 },
    }

    const result = await run(
      Effect.gen(function* () {
        const client = yield* ModelClient
        return yield* client.complete(handleWithAuth, [{ role: "user", content: "hello" }])
      }),
    )

    await new Promise<void>((resolve) => captureServer.close(() => resolve()))

    expect(result.text).toBe("captured")
    expect(capturedHeaders["authorization"]).toBe("Bearer sk-test-key")
    expect(capturedBody["max_tokens"]).toBe(256)
    expect(capturedBody["model"]).toBe("test-model")
  })
})

describe("ModelClient.complete", () => {
  it("returns the assistant content on a 200 response", async () => {
    mode = "ok"
    const result = await run(
      Effect.gen(function* () {
        const client = yield* ModelClient
        return yield* client.complete(handle(port), [{ role: "user", content: "ping" }])
      }),
    )
    expect(result.text).toBe("pong")
    expect(result.usage?.completionTokens).toBe(1)
  })

  it("fails with ModelError on a non-2xx response", async () => {
    mode = "500"
    const result = await run(
      Effect.gen(function* () {
        const client = yield* ModelClient
        return yield* client.complete(handle(port), [{ role: "user", content: "ping" }])
      }).pipe(Effect.either),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(ModelError)
      expect(result.left.reason).toContain("500")
      expect(result.left.message).toContain("endpoint=")
    }
  })

  it("fails with ModelError when the response has no choices content", async () => {
    mode = "garbage"
    const result = await run(
      Effect.gen(function* () {
        const client = yield* ModelClient
        return yield* client.complete(handle(port), [{ role: "user", content: "ping" }])
      }).pipe(Effect.either),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) expect(result.left.reason).toMatch(/malformed/i)
  })

  it("fails with ModelError when the endpoint is unreachable", async () => {
    const result = await run(
      Effect.gen(function* () {
        const client = yield* ModelClient
        // Port 1 is never listening.
        return yield* client.complete(handle(1), [{ role: "user", content: "ping" }])
      }).pipe(Effect.either),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) expect(result.left.reason).toMatch(/request failed|unreachable/i)
  })
})

describe("ModelClient.complete — reasoning-model tolerance", () => {
  const completeOk = (p: number) =>
    run(
      Effect.gen(function* () {
        const client = yield* ModelClient
        return yield* client.complete(handle(p), [{ role: "user", content: "ping" }])
      }),
    )

  it("falls back to message.reasoning when content is missing (does not fatal)", async () => {
    mode = "reasoning-only"
    const result = await completeOk(port)
    expect(result.text).toBe('{"disposition":"discard"}')
  })

  it("falls back to message.reasoning_content when content is missing", async () => {
    mode = "reasoning-content-field"
    const result = await completeOk(port)
    expect(result.text).toBe('{"disposition":"escalate"}')
  })

  it("falls back to reasoning when content is an empty string", async () => {
    mode = "reasoning-empty-content"
    const result = await completeOk(port)
    expect(result.text).toBe('{"disposition":"accumulate"}')
  })

  it("prefers content over reasoning when both are present", async () => {
    mode = "reasoning-and-content"
    const result = await completeOk(port)
    expect(result.text).toBe("real-answer")
  })

  it("still fails with ModelError when no usable text exists anywhere", async () => {
    mode = "truly-empty"
    const result = await run(
      Effect.gen(function* () {
        const client = yield* ModelClient
        return yield* client.complete(handle(port), [{ role: "user", content: "ping" }])
      }).pipe(Effect.either),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) expect(result.left.reason).toMatch(/malformed/i)
  })
})
