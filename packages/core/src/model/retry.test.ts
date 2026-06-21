import { describe, it, expect } from "vitest"
import { Effect, Either, Layer } from "effect"
import { ModelClient, makeModelClient, type ModelClientDeps } from "./client.js"
import { ModelError } from "./errors.js"
import type { ModelHandle } from "./handles.js"

const handle: ModelHandle = {
  tier: "hindbrain",
  provider: "openai-compatible",
  baseUrl: "http://mock.invalid/v1",
  model: "test",
}

// A minimal OK chat-completions response body.
const okBody = JSON.stringify({
  choices: [{ message: { role: "assistant", content: "pong" } }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
})

/** Build a Response-like object the client can consume. */
function jsonResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/json" } })
}

/**
 * Build a ModelClient layer with injected transport + instant (no-op) sleep so
 * tests are deterministic and make ZERO real network calls and incur ZERO delay.
 */
function clientLayer(deps: Partial<ModelClientDeps>): Layer.Layer<ModelClient> {
  return Layer.succeed(
    ModelClient,
    makeModelClient({
      // Default fetch always fails — every test must supply its own.
      fetchImpl: deps.fetchImpl ?? (() => Promise.reject(new TypeError("fetch failed"))),
      sleep: deps.sleep ?? (() => Promise.resolve()),
      retry: deps.retry,
    }),
  )
}

const run = <A, E>(eff: Effect.Effect<A, E, ModelClient>, layer: Layer.Layer<ModelClient>) =>
  Effect.runPromise(Effect.provide(eff, layer))

describe("ModelClient retry — transient failures", () => {
  it("retries a transient fetch failure and succeeds on a later attempt", async () => {
    let calls = 0
    const layer = clientLayer({
      fetchImpl: () => {
        calls++
        if (calls < 3) return Promise.reject(new TypeError("fetch failed"))
        return Promise.resolve(jsonResponse(200, okBody))
      },
      retry: { maxAttempts: 3, baseDelayMs: 1, timeoutMs: 1000 },
    })

    const result = await run(
      Effect.gen(function* () {
        const client = yield* ModelClient
        return yield* client.complete(handle, [{ role: "user", content: "ping" }])
      }),
      layer,
    )

    expect(result.text).toBe("pong")
    expect(calls).toBe(3)
  })

  it("retries an HTTP 503 (transient server error) then succeeds", async () => {
    let calls = 0
    const layer = clientLayer({
      fetchImpl: () => {
        calls++
        if (calls < 2) return Promise.resolve(jsonResponse(503, "model loading"))
        return Promise.resolve(jsonResponse(200, okBody))
      },
      retry: { maxAttempts: 3, baseDelayMs: 1, timeoutMs: 1000 },
    })

    const result = await run(
      Effect.gen(function* () {
        const client = yield* ModelClient
        return yield* client.complete(handle, [{ role: "user", content: "ping" }])
      }),
      layer,
    )

    expect(result.text).toBe("pong")
    expect(calls).toBe(2)
  })

  it("surfaces the original ModelError after exhausting all attempts", async () => {
    let calls = 0
    const layer = clientLayer({
      fetchImpl: () => {
        calls++
        return Promise.reject(new TypeError("fetch failed"))
      },
      retry: { maxAttempts: 3, baseDelayMs: 1, timeoutMs: 1000 },
    })

    const result = await run(
      Effect.gen(function* () {
        const client = yield* ModelClient
        return yield* client.complete(handle, [{ role: "user", content: "ping" }])
      }).pipe(Effect.either),
      layer,
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(ModelError)
      expect(result.left.reason).toMatch(/request failed|unreachable/i)
    }
    // maxAttempts total tries, not infinite.
    expect(calls).toBe(3)
  })

  it("aborts a request whose body read hangs, then retries it", async () => {
    let calls = 0
    const layer = clientLayer({
      fetchImpl: (_url, init) => {
        calls++
        const signal = (init as RequestInit | undefined)?.signal
        if (calls >= 2) return Promise.resolve(jsonResponse(200, okBody))
        // First call: headers arrive (200), but the body never resolves on its
        // own — only the abort signal ends it. This models a server that sends
        // status then stalls the body.
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            new Promise((_resolve, reject) => {
              if (signal) {
                signal.addEventListener("abort", () =>
                  reject(new DOMException("aborted", "AbortError")),
                )
              }
            }),
          text: () => Promise.resolve(""),
        } as unknown as Response)
      },
      sleep: () => Promise.resolve(),
      retry: { maxAttempts: 3, baseDelayMs: 1, timeoutMs: 10 },
    })

    const result = await run(
      Effect.gen(function* () {
        const client = yield* ModelClient
        return yield* client.complete(handle, [{ role: "user", content: "ping" }])
      }),
      layer,
    )

    expect(result.text).toBe("pong")
    expect(calls).toBe(2)
  })

  it("aborts a hung request via per-call timeout and retries it", async () => {
    let calls = 0
    const layer = clientLayer({
      fetchImpl: (_url, init) =>
        new Promise((resolve, reject) => {
          calls++
          if (calls >= 2) {
            resolve(jsonResponse(200, okBody))
            return
          }
          // First call never resolves on its own; only the abort signal ends it.
          const signal = (init as RequestInit | undefined)?.signal
          if (signal) {
            signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
          }
        }),
      sleep: () => Promise.resolve(),
      retry: { maxAttempts: 3, baseDelayMs: 1, timeoutMs: 10 },
    })

    const result = await run(
      Effect.gen(function* () {
        const client = yield* ModelClient
        return yield* client.complete(handle, [{ role: "user", content: "ping" }])
      }),
      layer,
    )

    expect(result.text).toBe("pong")
    expect(calls).toBe(2)
  })
})

describe("ModelClient retry — non-retryable failures are NOT retried", () => {
  it("does NOT retry an HTTP 401 (auth error)", async () => {
    let calls = 0
    const layer = clientLayer({
      fetchImpl: () => {
        calls++
        return Promise.resolve(jsonResponse(401, "unauthorized"))
      },
      retry: { maxAttempts: 3, baseDelayMs: 1, timeoutMs: 1000 },
    })

    const result = await run(
      Effect.gen(function* () {
        const client = yield* ModelClient
        return yield* client.complete(handle, [{ role: "user", content: "ping" }])
      }).pipe(Effect.either),
      layer,
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) expect(result.left.reason).toContain("401")
    expect(calls).toBe(1) // failed once, never retried
  })

  it("does NOT retry a malformed-content ModelError (genuine model error)", async () => {
    let calls = 0
    const layer = clientLayer({
      fetchImpl: () => {
        calls++
        return Promise.resolve(jsonResponse(200, '{"unexpected":true}'))
      },
      retry: { maxAttempts: 3, baseDelayMs: 1, timeoutMs: 1000 },
    })

    const result = await run(
      Effect.gen(function* () {
        const client = yield* ModelClient
        return yield* client.complete(handle, [{ role: "user", content: "ping" }])
      }).pipe(Effect.either),
      layer,
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) expect(result.left.reason).toMatch(/malformed/i)
    expect(calls).toBe(1) // genuine error surfaced immediately, no retry
  })
})
