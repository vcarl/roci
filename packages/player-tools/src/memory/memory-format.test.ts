import { describe, it, expect, vi } from "vitest"
import { formatResults, parseResults, parseEmbedResponse, type MemoryRow } from "./memory-format.js"
import { EMBED_DIM } from "./memory-sql.js"

describe("formatResults", () => {
  it("emits one NDJSON object per row with id/score/ts/tags/text", () => {
    const out = formatResults([
      { id: 7, distance: 0.17, ts: "2026-06-30T01:00:00Z", source: "conscious", tags: "place,calm", text: "the bar" },
      { id: 3, distance: 0.42, ts: "2026-06-29T01:00:00Z", source: "promotion", tags: null, text: "a fight" },
    ])
    const linesArr = out.split("\n")
    expect(linesArr).toHaveLength(2)
    const first = JSON.parse(linesArr[0])
    expect(first.id).toBe(7)
    expect(first.text).toBe("the bar")
    expect(first.ts).toBe("2026-06-30T01:00:00Z")
    expect(first.tags).toEqual(["place", "calm"])
    // score is derived from distance (closer = higher); monotonic, in [0,1].
    expect(typeof first.score).toBe("number")
    const second = JSON.parse(linesArr[1])
    expect(first.score).toBeGreaterThan(second.score)
    expect(second.tags).toEqual([])
  })
  it("returns an empty string for no rows (no spurious blank line)", () => {
    expect(formatResults([])).toBe("")
  })
  it("each line is independently valid JSON (true NDJSON)", () => {
    const out = formatResults([{ id: 1, distance: 0, ts: "t", source: "conscious", tags: "", text: "x" }])
    expect(() => JSON.parse(out)).not.toThrow()
  })
})

describe("parseEmbedResponse", () => {
  const vec = Array.from({ length: EMBED_DIM }, (_, i) => i / EMBED_DIM)
  it("extracts the embedding array from the OpenAI shape", () => {
    const v = parseEmbedResponse({ data: [{ embedding: vec }] })
    expect(v).toHaveLength(EMBED_DIM)
    expect(v[0]).toBe(0)
  })
  it("throws on a wrong-dimension vector", () => {
    expect(() => parseEmbedResponse({ data: [{ embedding: [1, 2, 3] }] })).toThrow()
  })
  it("throws when data is empty", () => {
    expect(() => parseEmbedResponse({ data: [] })).toThrow()
  })
  it("throws when the shape is unexpected", () => {
    expect(() => parseEmbedResponse({ nope: true })).toThrow()
    expect(() => parseEmbedResponse(null)).toThrow()
    expect(() => parseEmbedResponse({ data: [{ embedding: "not-an-array" }] })).toThrow()
  })
  it("throws when a vector element is not a finite number", () => {
    const bad = [...vec]
    bad[0] = Number.NaN
    expect(() => parseEmbedResponse({ data: [{ embedding: bad }] })).toThrow()
  })
})

describe("formatResults — provenance", () => {
  it("emits provenance per row", () => {
    const out = formatResults([
      { id: 1, distance: 0.1, ts: "2026-07-01T00:00:00Z", source: "observe", provenance: "grounded", tags: null, text: "docked" },
    ])
    expect(JSON.parse(out).provenance).toBe("grounded")
  })
})

describe("formatResults — dims", () => {
  it("emits a parsed dims object per row", () => {
    const out = formatResults([
      { id: 1, distance: 0.1, ts: "2026-07-01T00:00:00Z", source: "observe", provenance: "grounded", dims: JSON.stringify({ safety: 0.8 }), tags: null, text: "hull breach" },
    ])
    expect(JSON.parse(out).dims).toEqual({ safety: 0.8 })
  })
  it("emits null dims when the column is null", () => {
    const out = formatResults([
      { id: 1, distance: 0.1, ts: "2026-07-01T00:00:00Z", source: "orient", provenance: "inferred", dims: null, tags: null, text: "guess" },
    ])
    expect(JSON.parse(out).dims).toBeNull()
  })
})

describe("parseResults — inverse of formatResults", () => {
  const rows: MemoryRow[] = [
    { id: 7, distance: 0.17, ts: "2026-06-30T01:00:00Z", source: "observe", provenance: "grounded", dims: JSON.stringify({ safety: 0.8 }), tags: "place,calm", text: "the bar" },
    { id: 3, distance: 0.42, ts: "2026-06-29T01:00:00Z", source: "promotion", provenance: "episodic", dims: null, tags: null, text: "a fight" },
  ]

  it("round-trips formatResults output exactly (dims-as-object, tags-as-array, score present)", () => {
    const parsed = parseResults(formatResults(rows))
    expect(parsed).toEqual([
      { id: 7, ts: "2026-06-30T01:00:00Z", source: "observe", provenance: "grounded", dims: { safety: 0.8 }, tags: ["place", "calm"], text: "the bar", score: 1 / 1.17 },
      { id: 3, ts: "2026-06-29T01:00:00Z", source: "promotion", provenance: "episodic", dims: null, tags: [], text: "a fight", score: 1 / 1.42 },
    ])
  })

  it("omits score for recent rows (no distance) — round-trips without a score field", () => {
    const recent: MemoryRow[] = [
      { id: 9, ts: "t9", source: "conscious", provenance: "asserted", dims: null, tags: null, text: "nine" },
    ]
    const parsed = parseResults(formatResults(recent))
    expect(parsed[0]).not.toHaveProperty("score")
  })

  it("returns [] for empty output", () => {
    expect(parseResults("")).toEqual([])
  })

  it("LOGS then drops a torn line (no longer silent), keeping the good rows", () => {
    const onError = vi.fn()
    const ndjson = [formatResults([rows[0]]), "{not valid json", formatResults([rows[1]])].join("\n")
    const parsed = parseResults(ndjson, onError)
    expect(parsed.map((r) => r.id)).toEqual([7, 3])
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toBe("{not valid json")
  })

  it("default drop-logger warns before dropping (observable, not silent)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    parseResults("{broken")
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
