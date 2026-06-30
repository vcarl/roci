import { describe, it, expect } from "vitest"
import { Exit, Cause } from "effect"
import { sessionEndReasonForExit } from "./session-end.js"

describe("sessionEndReasonForExit", () => {
  it("maps a success exit to clean", () => {
    expect(sessionEndReasonForExit(Exit.succeed(undefined))).toEqual({ reason: "clean" })
  })

  it("maps an interrupt exit to signal", () => {
    const out = sessionEndReasonForExit(Exit.failCause(Cause.interrupt(Cause.empty as never)) as never)
    expect(out.reason).toBe("signal")
  })

  it("maps a defect/error exit to error", () => {
    expect(sessionEndReasonForExit(Exit.fail("boom")).reason).toBe("error")
  })
})
