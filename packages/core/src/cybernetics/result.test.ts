import { describe, it, expect } from "vitest"
import { toDelegationResult } from "./result.js"

describe("toDelegationResult", () => {
  it("maps a normal completion", () => {
    expect(toDelegationResult({ output: "done", timedOut: false, durationMs: 1200 })).toEqual({
      status: "completed",
      output: "done",
      durationMs: 1200,
    })
  })

  it("maps a timed-out turn to status timed_out", () => {
    const r = toDelegationResult({ output: "partial", timedOut: true, durationMs: 9000 })
    expect(r.status).toBe("timed_out")
    expect(r.output).toBe("partial")
  })
})
