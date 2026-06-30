import { describe, it, expect, beforeEach } from "vitest"
import {
  emptyBehaviorDigest,
  recordBehavior,
  snapshotDigest,
  resetBehaviorDigest,
  tryMarkEnded,
  recordShutdownSignal,
  consumeShutdownSignal,
} from "./behavior-digest.js"

beforeEach(() => {
  resetBehaviorDigest("ada")
})

describe("behavior digest accumulator", () => {
  it("counts by behavior type and records the type sequence", () => {
    recordBehavior("ada", { type: "session_start", domain: "spacemolt", character: "ada", gitSha: "abc", tickIntervalMs: 30000 }, "2026-06-30T00:00:00.000Z")
    recordBehavior("ada", { type: "phase", phase: "active", transition: "enter" }, "2026-06-30T00:00:01.000Z")
    recordBehavior("ada", { type: "phase", phase: "active", transition: "exit" }, "2026-06-30T00:00:02.000Z")
    const d = snapshotDigest("ada")
    expect(d.counts).toEqual({ session_start: 1, phase: 2 })
    expect(d.sequence).toEqual(["session_start", "phase", "phase"])
  })

  it("captures first-forebrain timing from a forebrain tier_call relative to session_start", () => {
    recordBehavior("ada", { type: "session_start", domain: "d", character: "ada", gitSha: "x", tickIntervalMs: 30000 }, "2026-06-30T00:00:00.000Z")
    recordBehavior("ada", { type: "tier_call", tier: "forebrain", latencyMs: 1800, outcome: "ok" }, "2026-06-30T00:00:02.000Z")
    expect(snapshotDigest("ada").timings.firstForebrainMs).toBe(2000)
  })

  it("captures first-plan timing from a plan decision", () => {
    recordBehavior("ada", { type: "session_start", domain: "d", character: "ada", gitSha: "x", tickIntervalMs: 30000 }, "2026-06-30T00:00:00.000Z")
    recordBehavior("ada", { type: "decision", disposition: "plan" }, "2026-06-30T00:00:05.000Z")
    expect(snapshotDigest("ada").timings.firstPlanMs).toBe(5000)
  })

  it("sets terminalCause from a session_end reason and signal", () => {
    recordBehavior("ada", { type: "session_start", domain: "d", character: "ada", gitSha: "x", tickIntervalMs: 30000 }, "2026-06-30T00:00:00.000Z")
    recordBehavior("ada", { type: "session_end", reason: "signal", signal: "SIGTERM", digest: emptyBehaviorDigest() }, "2026-06-30T00:00:09.000Z")
    expect(snapshotDigest("ada").terminalCause).toBe("session ended (signal: SIGTERM)")
  })

  it("isolates accumulators per character", () => {
    recordBehavior("ada", { type: "phase", phase: "active", transition: "enter" }, "2026-06-30T00:00:00.000Z")
    expect(snapshotDigest("bob").counts).toEqual({})
    resetBehaviorDigest("bob")
  })

  it("tryMarkEnded returns true once then false (idempotency guard)", () => {
    expect(tryMarkEnded("ada")).toBe(true)
    expect(tryMarkEnded("ada")).toBe(false)
  })

  it("captures and consumes the shutdown signal once", () => {
    recordShutdownSignal("SIGINT")
    expect(consumeShutdownSignal()).toBe("SIGINT")
    expect(consumeShutdownSignal()).toBeUndefined()
  })
})
