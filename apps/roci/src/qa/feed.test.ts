import { describe, it, expect } from "vitest"
import type { UnifiedEvent } from "@roci/core"
import { initialState, reduce } from "./feed.js"

const ev = (over: Partial<UnifiedEvent> & Pick<UnifiedEvent, "kind">): UnifiedEvent =>
  ({ timestamp: "2026-06-21T00:00:00.000Z", character: "ada", system: "cortex", subsystem: "cortex", ...over } as UnifiedEvent)

const run = (events: UnifiedEvent[]) => {
  let s = initialState
  const all = []
  for (const e of events) {
    const out = reduce(s, e)
    s = out.state
    all.push(...out.records)
  }
  return { state: s, records: all }
}

describe("reduce", () => {
  it("emits SESSION_START on the very first event", () => {
    const { records } = run([ev({ kind: "system", message: "hindbrain: discard 😐" })])
    expect(records[0].type).toBe("SESSION_START")
  })

  it("counts a tick per hindbrain pass and stamps transitions with it", () => {
    const { state, records } = run([
      ev({ kind: "system", message: "hindbrain: escalate 😰" }),
      ev({ kind: "system", message: "forebrain: regroup" }),
      ev({ kind: "system", message: "hindbrain: continue 🙂" }),
    ])
    expect(state.tick).toBe(2)
    const escalate = records.find((r) => r.type === "ESCALATE")
    expect(escalate?.tick).toBe(1)
    const forebrain = records.find((r) => r.type === "FOREBRAIN")
    expect(forebrain?.tick).toBe(1)
  })

  it("emits an ERROR anomaly for kind:error events", () => {
    const { records } = run([
      ev({ kind: "system", message: "hindbrain: discard 😐" }),
      ev({ kind: "error", message: "event error: boom" } as Partial<UnifiedEvent> & { kind: "error" }),
    ])
    const err = records.find((r) => r.kind === "anomaly")
    expect(err?.type).toBe("ERROR")
    expect(err?.severity).toBe("error")
    expect(err?.summary).toContain("boom")
  })
})
