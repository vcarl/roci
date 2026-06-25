import { describe, it, expect } from "vitest"
import { reviewDecisionFromAnswer } from "./guided-setup.js"

describe("reviewDecisionFromAnswer", () => {
  it("accept keeps the original content", () => {
    expect(reviewDecisionFromAnswer("accept", "orig", "ignored", "")).toEqual({ action: "accept", content: "orig" })
  })
  it("edit accepts the edited content", () => {
    expect(reviewDecisionFromAnswer("edit", "orig", "edited!", "")).toEqual({ action: "accept", content: "edited!" })
  })
  it("regenerate carries trimmed feedback, undefined when blank", () => {
    expect(reviewDecisionFromAnswer("regenerate", "o", "o", "  do better ")).toEqual({ action: "regenerate", feedback: "do better" })
    expect(reviewDecisionFromAnswer("regenerate", "o", "o", "   ")).toEqual({ action: "regenerate", feedback: undefined })
  })
  it("skip", () => {
    expect(reviewDecisionFromAnswer("skip", "o", "o", "")).toEqual({ action: "skip" })
  })
})
