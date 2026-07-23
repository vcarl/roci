import { describe, it, expect } from "vitest"
import { embedEndpoint } from "./embed-endpoint.js"

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
