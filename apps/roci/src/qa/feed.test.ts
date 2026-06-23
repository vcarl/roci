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

  it("emits a FATAL_ERROR anomaly for a model-call fatal system event", () => {
    const msg =
      "Fatal error: Model call failed [tier=conscious model=mlx-community/Qwen3.5-122B-A10B-4bit endpoint=http://127.0.0.1:8083/v1]: request failed (endpoint unreachable?): TypeError: fetch failed"
    const { records } = run([ev({ kind: "system", message: msg })])
    const anomaly = records.find((r) => r.kind === "anomaly")
    expect(anomaly?.type).toBe("FATAL_ERROR")
    expect(anomaly?.severity).toBe("error")
    expect(anomaly?.summary).toContain("tier=conscious")
    expect(anomaly?.refs?.tier).toBe("conscious")
  })

  it("emits a FATAL_ERROR anomaly for a non-model-call fatal system event", () => {
    const { records } = run([ev({ kind: "system", message: "Fatal error: something unexpected" })])
    const anomaly = records.find((r) => r.kind === "anomaly")
    expect(anomaly?.type).toBe("FATAL_ERROR")
    expect(anomaly?.summary).toContain("something unexpected")
  })

  it("does not emit a FATAL_ERROR anomaly for a normal system event", () => {
    const { records } = run([ev({ kind: "system", message: "hindbrain: discard 😐" })])
    const anomaly = records.find((r) => r.kind === "anomaly" && r.type === "FATAL_ERROR")
    expect(anomaly).toBeUndefined()
  })

  // Task 3 — DEGRADED_TIER detector
  // Real fixture from players/kvothe/logs/events.jsonl line 22:
  // {"timestamp":"2026-06-21T18:07:33.070Z","character":"kvothe","system":"cortex","subsystem":"cortex","kind":"system","message":"hindbrain: undefined undefined"}
  it("emits a DEGRADED_TIER anomaly for a tier output that is undefined", () => {
    const { records } = run([ev({ kind: "system", message: "hindbrain: undefined undefined" })])
    const anomaly = records.find((r) => r.kind === "anomaly" && r.type === "DEGRADED_TIER")
    expect(anomaly?.type).toBe("DEGRADED_TIER")
    expect(anomaly?.severity).toBe("warn")
    expect(anomaly?.refs?.tier).toBe("hindbrain")
  })

  it("does not emit a DEGRADED_TIER anomaly for a healthy hindbrain line", () => {
    const { records } = run([ev({ kind: "system", message: "hindbrain: accumulate 😊😊😊" })])
    const anomaly = records.find((r) => r.kind === "anomaly" && r.type === "DEGRADED_TIER")
    expect(anomaly).toBeUndefined()
  })

  it("does not emit a DEGRADED_TIER anomaly for a healthy forebrain line", () => {
    const { records } = run([
      ev({ kind: "system", message: "forebrain (in-session): docked — docked" }),
    ])
    const anomaly = records.find((r) => r.kind === "anomaly" && r.type === "DEGRADED_TIER")
    expect(anomaly).toBeUndefined()
  })
})
