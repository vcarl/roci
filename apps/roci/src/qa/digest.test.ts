import { describe, it, expect } from "vitest"
import type { FeedRecord } from "./types.js"
import { emptyDigest, foldDigest, toPublicDigest } from "./digest.js"

const env = { character: "ada", domain: "spacemolt", tickIntervalMs: 30000, gitSha: "abc1234" }
const rec = (over: Partial<FeedRecord>): FeedRecord =>
  ({ ts: "2026-06-21T00:00:00.000Z", kind: "transition", type: "SESSION_START", severity: "info", tick: 0, summary: "", ...over } as FeedRecord)

const fold = (recs: FeedRecord[]) => recs.reduce(foldDigest, emptyDigest(env))

describe("foldDigest", () => {
  it("counts records by type and records the transition sequence", () => {
    const d = fold([
      rec({ type: "SESSION_START" }),
      rec({ type: "ESCALATE" }),
      rec({ type: "FOREBRAIN" }),
    ])
    expect(d.counts.ESCALATE).toBe(1)
    expect(d.sequence).toEqual(["SESSION_START", "ESCALATE", "FOREBRAIN"])
  })

  it("captures time-to-first-forebrain and first-plan from SESSION_START", () => {
    const d = fold([
      rec({ type: "SESSION_START", ts: "2026-06-21T00:00:00.000Z" }),
      rec({ type: "FOREBRAIN", ts: "2026-06-21T00:00:02.000Z" }),
      rec({ type: "DECISION", summary: "conscious decision: plan", ts: "2026-06-21T00:00:05.000Z" }),
    ])
    expect(d.timings.firstForebrainMs).toBe(2000)
    expect(d.timings.firstPlanMs).toBe(5000)
  })

  it("does not add anomalies to the transition sequence", () => {
    const d = fold([rec({ type: "SESSION_START" }), rec({ kind: "anomaly", type: "ERROR" })])
    expect(d.sequence).toEqual(["SESSION_START"])
    expect(d.counts.ERROR).toBe(1)
  })

  describe("terminalCause", () => {
    it("FATAL_ERROR anomaly sets terminalCause to its summary", () => {
      const d = fold([
        rec({ type: "SESSION_START" }),
        rec({ kind: "anomaly", type: "FATAL_ERROR", summary: "fatal: Model call failed (tier=conscious)" }),
      ])
      expect(d.terminalCause).toContain("tier=conscious")
    })

    it("FATAL_ERROR wins over subsequent PROCESS_DIED (precedence)", () => {
      const d = fold([
        rec({ type: "SESSION_START" }),
        rec({ kind: "anomaly", type: "FATAL_ERROR", summary: "fatal: Model call failed (tier=conscious)" }),
        rec({ kind: "anomaly", type: "PROCESS_DIED", summary: "session process 45107 exited" }),
      ])
      expect(d.terminalCause).toContain("tier=conscious")
    })

    it("PROCESS_DIED-only sets terminalCause to its summary", () => {
      const d = fold([
        rec({ type: "SESSION_START" }),
        rec({ kind: "anomaly", type: "PROCESS_DIED", summary: "session process 45107 exited" }),
      ])
      expect(d.terminalCause).toContain("session process 45107 exited")
    })

    it("no terminal records yields terminalCause null", () => {
      const d = fold([
        rec({ type: "SESSION_START" }),
        rec({ kind: "anomaly", type: "STALL", summary: "stall detected" }),
      ])
      expect(d.terminalCause).toBeNull()
    })
  })
})

describe("toPublicDigest", () => {
  it("strips _terminalRank from the serialized output while preserving all real fields", () => {
    const d = fold([
      rec({ type: "SESSION_START" }),
      rec({ kind: "anomaly", type: "FATAL_ERROR", summary: "fatal: Model call failed (tier=conscious)" }),
    ])
    const pub = toPublicDigest(d)

    // (a) real fields intact
    expect(pub.terminalCause).toContain("tier=conscious")
    expect(pub.env).toEqual(env)
    expect(pub.counts).toBeDefined()
    expect(pub.sequence).toBeDefined()
    expect(pub.timings).toBeDefined()

    // (b) _terminalRank not present as own property
    expect(Object.prototype.hasOwnProperty.call(pub, "_terminalRank")).toBe(false)

    // (c) serialized form excludes _terminalRank
    expect(JSON.stringify(pub)).not.toContain("_terminalRank")
  })
})
