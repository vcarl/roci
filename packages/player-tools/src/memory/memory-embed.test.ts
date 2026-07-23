import { describe, it, expect, vi } from "vitest"
import { embed, backoffDelayMs } from "./memory-embed.js"
import { EMBED_DIM } from "./memory-sql.js"

/**
 * The final embeddings endpoint the entrypoint passes to `embed()`. In the
 * container this is the already-host-rewritten `MEMORY_EMBED_URL` env value; the
 * loopback → host.docker.internal rewrite (`embedEndpoint`) is tested host-side
 * in `@roci/core` (embed-endpoint.test.ts), not here — this leaf uses the URL
 * verbatim (spec §3).
 */
const ENDPOINT = "http://host.docker.internal:8084/v1/embeddings"

const okVec = Array.from({ length: EMBED_DIM }, (_, i) => i / EMBED_DIM)
const okResponse = (vec = okVec) =>
  ({ ok: true, json: async () => ({ data: [{ embedding: vec }] }) }) as unknown as Response
const statusResponse = (status: number) =>
  ({ ok: status >= 200 && status < 300, status }) as unknown as Response

/** Fast test options: no real backoff sleeps, tight per-attempt timeout. */
const fast = { sleep: async () => {}, baseDelayMs: 1, maxDelayMs: 1, timeoutMs: 50 }

describe("backoffDelayMs", () => {
  it("grows exponentially from the base and clamps at the cap", () => {
    expect(backoffDelayMs(0, 500, 8000)).toBe(500)
    expect(backoffDelayMs(1, 500, 8000)).toBe(1000)
    expect(backoffDelayMs(2, 500, 8000)).toBe(2000)
    expect(backoffDelayMs(3, 500, 8000)).toBe(4000)
    expect(backoffDelayMs(4, 500, 8000)).toBe(8000)
    // Clamped: never exceeds the cap no matter how many doublings.
    expect(backoffDelayMs(10, 500, 8000)).toBe(8000)
  })
})

describe("embed", () => {
  it("POSTs the plain text (no instruction prefix) and returns the parsed vector", async () => {
    const fetchImpl = vi.fn(async () => okResponse())
    const v = await embed("a quiet station", ENDPOINT, fetchImpl as unknown as typeof fetch)
    expect(v).toHaveLength(EMBED_DIM)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    // Used VERBATIM — no rewrite, no append (spec §3).
    expect(url).toBe(ENDPOINT)
    expect(init.method).toBe("POST")
    const body = JSON.parse(init.body as string)
    expect(body.input).toBe("a quiet station")
    // A per-attempt timeout is wired via an AbortController signal.
    expect(init.signal).toBeDefined()
  })

  it("retries past transient cold-start failures and succeeds (connection refused, then 503, then ready)", async () => {
    const fetchImpl = vi
      .fn()
      // 1: connection refused (fetch throws)
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      // 2: model still loading
      .mockResolvedValueOnce(statusResponse(503))
      // 3: ready
      .mockResolvedValueOnce(okResponse())
    const v = await embed("x", ENDPOINT, fetchImpl as unknown as typeof fetch, fast)
    expect(v).toHaveLength(EMBED_DIM)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it("gives up after the attempt budget with a clear error (server never comes up)", async () => {
    const fetchImpl = vi.fn(async () => statusResponse(503))
    await expect(
      embed("x", ENDPOINT, fetchImpl as unknown as typeof fetch, { ...fast, attempts: 4 }),
    ).rejects.toThrow(/after 4 attempts/)
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })

  it("does NOT retry on a permanent 4xx (fails fast on the first attempt)", async () => {
    const fetchImpl = vi.fn(async () => statusResponse(400))
    await expect(
      embed("x", ENDPOINT, fetchImpl as unknown as typeof fetch, { ...fast, attempts: 6 }),
    ).rejects.toThrow(/HTTP 400/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("respects the per-attempt timeout (aborts a hung request) and retries", async () => {
    let aborts = 0
    // A fetch that never resolves on its own — it only settles when the
    // AbortController fires, modelling a hung connection the timeout must cut.
    const hanging = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal) {
          signal.addEventListener("abort", () => {
            aborts++
            reject(new DOMException("The operation was aborted.", "AbortError"))
          })
        }
      })
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(hanging)
      .mockImplementationOnce(hanging)
      .mockResolvedValueOnce(okResponse())
    const v = await embed(
      "x",
      ENDPOINT,
      fetchImpl as unknown as typeof fetch,
      { ...fast, timeoutMs: 10 },
    )
    expect(v).toHaveLength(EMBED_DIM)
    expect(aborts).toBe(2)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it("throws on a wrong-dimension embedding without retrying (corrupt body is permanent)", async () => {
    const fetchImpl = vi.fn(async () => okResponse([1, 2, 3]))
    await expect(
      embed("x", ENDPOINT, fetchImpl as unknown as typeof fetch, fast),
    ).rejects.toThrow()
    // A 200 with a malformed body is not a cold-start condition: no retry.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
