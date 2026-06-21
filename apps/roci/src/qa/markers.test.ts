import { describe, it, expect } from "vitest"
import type { UnifiedEvent } from "@roci/core"
import { classifyEvent } from "./markers.js"

const sys = (message: string): UnifiedEvent => ({
  timestamp: "2026-06-21T00:00:00.000Z",
  character: "ada",
  system: "cortex",
  subsystem: "cortex",
  kind: "system",
  message,
})

describe("classifyEvent", () => {
  it("classifies an escalate hindbrain pass as ESCALATE", () => {
    const m = classifyEvent(sys("hindbrain: escalate 😰"))
    expect(m?.type).toBe("ESCALATE")
    expect(m?.fields.disposition).toBe("escalate")
  })

  it("returns null for discard/continue hindbrain passes (silent)", () => {
    expect(classifyEvent(sys("hindbrain: discard 😐"))).toBeNull()
    expect(classifyEvent(sys("hindbrain: continue 🙂"))).toBeNull()
  })

  it("distinguishes idle vs in-session forebrain", () => {
    expect(classifyEvent(sys("forebrain: hold position"))?.fields.inSession).toBe("false")
    expect(classifyEvent(sys("forebrain (in-session): re-route"))?.fields.inSession).toBe("true")
  })

  it("classifies conscious decision, step start, steer", () => {
    expect(classifyEvent(sys("conscious: plan"))?.type).toBe("DECISION")
    expect(classifyEvent(sys("conscious turn 1: scout the ridge"))?.type).toBe("STEP_START")
    expect(classifyEvent(sys("conscious steer turn (session ses_001)"))?.type).toBe("STEER")
  })

  it("classifies step done, salvage, evaluate, critical", () => {
    expect(classifyEvent(sys("step done-marker detected; evaluating"))?.type).toBe("STEP_DONE")
    expect(classifyEvent(sys("step tick-budget elapsed (5/3); salvage evaluate"))?.type).toBe("STEP_SALVAGE")
    expect(classifyEvent(sys("evaluate: succeeded → next_step"))?.type).toBe("EVALUATE")
    expect(classifyEvent(sys("Critical: hull breach"))?.type).toBe("CRITICAL")
  })

  it("best-effort DELEGATION from a frontier tool_use", () => {
    const ev: UnifiedEvent = {
      timestamp: "2026-06-21T00:00:00.000Z",
      character: "ada",
      system: "cortex",
      subsystem: "conscious",
      kind: "tool_use",
      tool: "bash",
      id: "t1",
      input: { command: "frontier start 'refactor the parser'" },
    }
    expect(classifyEvent(ev)?.type).toBe("DELEGATION")
  })

  it("returns null for unrelated events", () => {
    expect(classifyEvent(sys("forebrain unrelated chatter without colon"))).toBeNull()
    expect(classifyEvent({ ...sys("x"), kind: "thinking", text: "hmm" } as UnifiedEvent)).toBeNull()
  })
})
