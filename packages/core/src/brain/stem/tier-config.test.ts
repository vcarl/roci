import { describe, it, expect } from "vitest"
import { isResponseTruncated, classifyTierOutcome } from "./tier-config.js"

describe("isResponseTruncated", () => {
  it("flags a completion that reached the token ceiling", () => {
    expect(isResponseTruncated({ completionTokens: 1024 }, 1024, "length")).toBe(true)
  })
  it("flags on completionTokens >= maxTokens even without a finish reason", () => {
    expect(isResponseTruncated({ completionTokens: 1100 }, 1024, undefined)).toBe(true)
  })
  it("flags on finish_reason=length even when tokens are unknown", () => {
    expect(isResponseTruncated(undefined, undefined, "length")).toBe(true)
  })
  it("does not flag a normal stop under budget", () => {
    expect(isResponseTruncated({ completionTokens: 200 }, 1024, "stop")).toBe(false)
  })
  it("does not flag when maxTokens is unknown and stop is normal", () => {
    expect(isResponseTruncated({ completionTokens: 5000 }, undefined, "stop")).toBe(false)
  })
  it("does not flag when there is no usage and no length signal", () => {
    expect(isResponseTruncated(undefined, 1024, undefined)).toBe(false)
  })
})

describe("classifyTierOutcome", () => {
  it("classifies a TimeoutException as timeout", () => {
    expect(classifyTierOutcome({ _tag: "TimeoutException" })).toBe("timeout")
  })
  it("classifies an unknown error as error", () => {
    expect(classifyTierOutcome(new Error("boom"))).toBe("error")
  })
})
