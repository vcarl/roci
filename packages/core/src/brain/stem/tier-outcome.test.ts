import { describe, it, expect } from "vitest"
import { classifyTierOutcome } from "./tier-config.js"
import { ReadinessError } from "../../services/model-backend.js"

describe("classifyTierOutcome", () => {
  it("classifies a timed-out ReadinessError as timeout", () => {
    expect(classifyTierOutcome(new ReadinessError("forebrain", "m", "probe timed out", true))).toBe("timeout")
  })

  it("classifies a non-timeout ReadinessError as error", () => {
    expect(classifyTierOutcome(new ReadinessError("forebrain", "m", "dead", false))).toBe("error")
  })

  it("classifies an effect timeout-tagged error as timeout", () => {
    expect(classifyTierOutcome({ _tag: "TimeoutException" })).toBe("timeout")
  })

  it("classifies an arbitrary error as error", () => {
    expect(classifyTierOutcome(new Error("boom"))).toBe("error")
  })
})
