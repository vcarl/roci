import { describe, it, expect } from "vitest"
import { SpawnError, ReadinessError, ModelCrashed } from "./model-backend.js"

describe("backend errors", () => {
  it("SpawnError carries tier/model and a readable message", () => {
    const e = new SpawnError("hindbrain", "m", "exec failed")
    expect(e._tag).toBe("SpawnError")
    expect(e.message).toContain("hindbrain")
    expect(e.message).toContain("exec failed")
  })
  it("ReadinessError flags timeout", () => {
    const e = new ReadinessError("conscious", "m", "probe deadline", true)
    expect(e._tag).toBe("ReadinessError")
    expect(e.timedOut).toBe(true)
    expect(e.message).toContain("conscious")
  })
  it("ModelCrashed is a distinct tag", () => {
    const e = new ModelCrashed("forebrain", "m", "exited")
    expect(e._tag).toBe("ModelCrashed")
    expect(e.message).toContain("forebrain")
  })
})
