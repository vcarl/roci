import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { describe, it, expect, afterEach } from "vitest"
import {
  DEFAULT_ROTATE_BYTES,
  ROTATE_BYTES_ENV,
  SEGMENT_MARKER_TYPE,
  appendRotatingLine,
  resetLogRotationState,
  resolveRotateBytes,
  segmentFileName,
} from "./log-rotation.js"

const FILE = "recall-telemetry.jsonl"

afterEach(() => resetLogRotationState())

const tmp = (): string => mkdtempSync(path.join(tmpdir(), "roci-rot-"))
const readLines = (p: string): string[] => readFileSync(p, "utf8").trim().split("\n")

describe("segment naming", () => {
  it("zero-pads so lexical order is chronological order", () => {
    expect(segmentFileName(FILE, 1)).toBe("recall-telemetry.00001.jsonl")
    expect(segmentFileName(FILE, 42)).toBe("recall-telemetry.00042.jsonl")
    expect([segmentFileName(FILE, 10), segmentFileName(FILE, 2)].sort()).toEqual([
      "recall-telemetry.00002.jsonl",
      "recall-telemetry.00010.jsonl",
    ])
  })
})

describe("threshold resolution", () => {
  it("falls back to the default on a malformed value, but honours an explicit 0", () => {
    expect(resolveRotateBytes({})).toBe(DEFAULT_ROTATE_BYTES)
    expect(resolveRotateBytes({ [ROTATE_BYTES_ENV]: "nonsense" })).toBe(DEFAULT_ROTATE_BYTES)
    expect(resolveRotateBytes({ [ROTATE_BYTES_ENV]: "-1" })).toBe(DEFAULT_ROTATE_BYTES)
    expect(resolveRotateBytes({ [ROTATE_BYTES_ENV]: "0" })).toBe(0)
    expect(resolveRotateBytes({ [ROTATE_BYTES_ENV]: "1024" })).toBe(1024)
  })
})

/**
 * The one test that matters: cross the boundary repeatedly and prove that
 * concatenating the segments in order reproduces EVERY record, in order, with a
 * seam an analyst cannot step over without noticing.
 */
describe("rotation across a real filesystem", () => {
  it("segments at the boundary, loses no line across the seam, and chains the markers", async () => {
    const dir = tmp()
    const N = 40
    for (let i = 1; i <= N; i += 1) {
      await appendRotatingLine(dir, FILE, `${JSON.stringify({ type: "recall", n: i })}\n`, 120)
    }

    const files = readdirSync(dir).sort()
    const segments = files.filter((f) => f !== FILE)
    expect(segments.length).toBeGreaterThan(2) // it really did rotate, several times
    expect(files).toContain(FILE) // …and the active name never changes

    // Concatenate in lexical order — which the padding makes chronological —
    // then the active file last.
    const all = [...segments.map((f) => path.join(dir, f)), path.join(dir, FILE)].flatMap(readLines)
    const records = all.map((l) => JSON.parse(l))

    // NOTHING WAS LOST AND NOTHING WAS REORDERED.
    expect(records.filter((r) => r.type === "recall").map((r) => r.n)).toEqual(
      Array.from({ length: N }, (_, i) => i + 1),
    )

    // Every seam is a close immediately followed by the open that names it.
    const markers = records.filter((r) => r.type === SEGMENT_MARKER_TYPE)
    // One close + one open per rotation; the final open lives in the active file.
    expect(markers.length).toBe(segments.length * 2)
    for (let i = 0; i < records.length; i += 1) {
      const r = records[i]
      if (r.type !== SEGMENT_MARKER_TYPE || r.event !== "close") continue
      const nxt = records[i + 1]
      expect(nxt.type).toBe(SEGMENT_MARKER_TYPE)
      expect(nxt.event).toBe("open")
      // The chain check: a missing segment shows up here as a mismatch.
      expect(nxt.segment).toBe(r.next.segment)
      expect(nxt.previous.segment).toBe(r.segment)
      expect(nxt.previous.file).toBe(r.file)
      // …and the recorded size is the segment's real on-disk size, so a
      // truncated copy is detectable without reading the file.
      expect(statSync(path.join(dir, r.file)).size).toBe(nxt.previous.bytes)
    }
    // Segment numbers are dense and increase forever; nothing was deleted.
    const closes = markers.filter((m) => m.event === "close").map((m) => m.segment)
    expect(closes).toEqual(Array.from({ length: closes.length }, (_, i) => i + 1))
    expect(segments).toEqual(closes.map((n) => segmentFileName(FILE, n)))

    rmSync(dir, { recursive: true, force: true })
  })

  it("a record is never split across segments, so a segment may overshoot by one", async () => {
    const dir = tmp()
    const line = `${JSON.stringify({ type: "recall", pad: "x".repeat(200) })}\n`
    for (let i = 0; i < 4; i += 1) await appendRotatingLine(dir, FILE, line, 50)
    for (const f of readdirSync(dir)) {
      for (const l of readLines(path.join(dir, f))) expect(() => JSON.parse(l)).not.toThrow()
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it("resumes numbering from what is already on disk, never overwriting a segment", async () => {
    const dir = tmp()
    for (let i = 0; i < 12; i += 1) {
      await appendRotatingLine(dir, FILE, `${JSON.stringify({ type: "recall", n: i })}\n`, 120)
    }
    const before = readdirSync(dir).filter((f) => f !== FILE).sort()
    expect(before.length).toBeGreaterThan(0)
    const firstSegment = readFileSync(path.join(dir, before[0]), "utf8")

    // A fresh process: state forgotten, the same directory.
    resetLogRotationState()
    for (let i = 100; i < 112; i += 1) {
      await appendRotatingLine(dir, FILE, `${JSON.stringify({ type: "recall", n: i })}\n`, 120)
    }
    const after = readdirSync(dir).filter((f) => f !== FILE).sort()
    expect(after.length).toBeGreaterThan(before.length)
    expect(after.slice(0, before.length)).toEqual(before)
    // The oldest segment is byte-identical: rotation renames, it never rewrites.
    expect(readFileSync(path.join(dir, before[0]), "utf8")).toBe(firstSegment)
    rmSync(dir, { recursive: true, force: true })
  })

  it("never rotates when the threshold is 0, and never creates a marker", async () => {
    const dir = tmp()
    for (let i = 0; i < 20; i += 1) {
      await appendRotatingLine(dir, FILE, `${JSON.stringify({ type: "recall", n: i })}\n`, 0)
    }
    expect(readdirSync(dir)).toEqual([FILE])
    expect(readFileSync(path.join(dir, FILE), "utf8")).not.toContain(SEGMENT_MARKER_TYPE)
    rmSync(dir, { recursive: true, force: true })
  })

  it("concurrent appends interleave no lines and lose none", async () => {
    const dir = tmp()
    const N = 60
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        appendRotatingLine(dir, FILE, `${JSON.stringify({ type: "recall", n: i })}\n`, 150),
      ),
    )
    const all = readdirSync(dir)
      .sort()
      .flatMap((f) => readLines(path.join(dir, f)))
    for (const l of all) expect(() => JSON.parse(l)).not.toThrow()
    expect(all.filter((l) => l.includes(`"type":"recall"`))).toHaveLength(N)
    rmSync(dir, { recursive: true, force: true })
  })
})
