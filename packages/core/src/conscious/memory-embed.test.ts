import { describe, it, expect, vi } from "vitest"
import { embed, embedEndpoint } from "./memory-embed.js"
import { EMBED_DIM } from "./memory-sql.js"

const okVec = Array.from({ length: EMBED_DIM }, (_, i) => i / EMBED_DIM)
const okResponse = (vec = okVec) =>
  ({ ok: true, json: async () => ({ data: [{ embedding: vec }] }) }) as unknown as Response

describe("embedEndpoint", () => {
  it("rewrites a loopback base URL to host.docker.internal and appends /embeddings", () => {
    expect(embedEndpoint("http://127.0.0.1:8084/v1")).toBe(
      "http://host.docker.internal:8084/v1/embeddings",
    )
  })
  it("leaves a non-loopback host untouched", () => {
    expect(embedEndpoint("http://host.docker.internal:8084/v1")).toBe(
      "http://host.docker.internal:8084/v1/embeddings",
    )
  })
})

describe("embed", () => {
  it("POSTs the plain text (no instruction prefix) and returns the parsed vector", async () => {
    const fetchImpl = vi.fn(async () => okResponse())
    const v = await embed("a quiet station", "http://127.0.0.1:8084/v1", fetchImpl as unknown as typeof fetch)
    expect(v).toHaveLength(EMBED_DIM)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("http://host.docker.internal:8084/v1/embeddings")
    expect(init.method).toBe("POST")
    const body = JSON.parse(init.body as string)
    expect(body.input).toBe("a quiet station")
  })
  it("throws on a non-ok HTTP response", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }) as unknown as Response)
    await expect(
      embed("x", "http://127.0.0.1:8084/v1", fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow()
  })
  it("throws on a wrong-dimension embedding (propagates parseEmbedResponse)", async () => {
    const fetchImpl = vi.fn(async () => okResponse([1, 2, 3]))
    await expect(
      embed("x", "http://127.0.0.1:8084/v1", fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow()
  })
})
