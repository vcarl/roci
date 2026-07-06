import { describe, it, expect } from "vitest"
import { hostInternalBaseUrl } from "./host-url.js"

describe("hostInternalBaseUrl", () => {
  it("rewrites host loopback to host.docker.internal, preserving port and path", () => {
    expect(hostInternalBaseUrl("http://127.0.0.1:8083/v1")).toBe("http://host.docker.internal:8083/v1")
    expect(hostInternalBaseUrl("http://localhost:8083/v1")).toBe("http://host.docker.internal:8083/v1")
    expect(hostInternalBaseUrl("http://0.0.0.0:8083/v1")).toBe("http://host.docker.internal:8083/v1")
  })
  it("leaves a non-loopback host unchanged", () => {
    expect(hostInternalBaseUrl("http://10.0.0.5:8083/v1")).toBe("http://10.0.0.5:8083/v1")
  })
})
