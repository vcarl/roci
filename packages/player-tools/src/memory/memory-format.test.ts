import { describe, it, expect, vi } from "vitest"
import { formatResults, formatPending, parseResults, parseEmbedResponse, type MemoryRow } from "./memory-format.js"
import { EMBED_DIM, buildKnnSql, buildRecentSql, buildPendingSql } from "./memory-sql.js"

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
      // stage: null — these fixture rows carry no dims_stage (Phase 2 column absent).
      { id: 7, ts: "2026-06-30T01:00:00Z", source: "observe", provenance: "grounded", dims: { safety: 0.8 }, stage: null, tags: ["place", "calm"], text: "the bar", score: 1 / 1.17 },
      { id: 3, ts: "2026-06-29T01:00:00Z", source: "promotion", provenance: "episodic", dims: null, stage: null, tags: [], text: "a fight", score: 1 / 1.42 },
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

describe("phase 2 NDJSON carry-through", () => {
  const row = {
    id: 7,
    ts: "2026-07-31T00:00:00.000Z",
    source: "observe",
    provenance: "grounded",
    dims: '{"safety":0.6,"grumbling-tender":-0.4}',
    dims_a: '{"safety":0.4}',
    dims_c: '{"safety":0.8,"grumbling-tender":-0.4}',
    dims_stage: "base",
    tags: "a,b",
    text: "hull scraped",
    distance: 0.25,
  }

  it("search rows carry dims as an object AND the stage marker", () => {
    const obj = JSON.parse(formatResults([row]))
    expect(obj.dims).toEqual({ safety: 0.6, "grumbling-tender": -0.4 })
    expect(obj.stage).toBe("base")
    expect(obj.tags).toEqual(["a", "b"])
    expect(typeof obj.score).toBe("number")
  })

  it("a legacy row with NULL dims still renders, stage and dims both null-ish", () => {
    const obj = JSON.parse(
      formatResults([{ ...row, dims: null, dims_a: null, dims_c: null, dims_stage: "legacy" }]),
    )
    expect(obj.dims).toBeNull()
    expect(obj.stage).toBe("legacy")
  })

  it("search rows do NOT leak dims_a / dims_c — recall needs the best vector only", () => {
    const obj = JSON.parse(formatResults([row]))
    expect(obj).not.toHaveProperty("dims_a")
    expect(obj).not.toHaveProperty("dims_c")
  })

  it("formatPending emits id + text + BOTH producer vectors, parsed", () => {
    const obj = JSON.parse(formatPending([row]))
    expect(obj).toEqual({
      id: 7,
      text: "hull scraped",
      dims_a: { safety: 0.4 },
      dims_c: { safety: 0.8, "grumbling-tender": -0.4 },
    })
  })

  it("formatPending renders a missing C as null, not as {}", () => {
    // Pathway 6 (agent-authored) has no C at all — B must be able to tell that
    // apart from 'the producer scored every axis at zero'.
    const obj = JSON.parse(formatPending([{ ...row, dims_c: null }]))
    expect(obj.dims_c).toBeNull()
    expect(obj.dims_a).toEqual({ safety: 0.4 })
  })

  it("formatPending renders no rows as the empty string", () => {
    expect(formatPending([])).toBe("")
  })

  it("parseResults round-trips the stage marker", () => {
    expect(parseResults(formatResults([row]))[0].stage).toBe("base")
  })
})

/**
 * THE SEAM. Every test above hand-writes the row object; every test in
 * memory-sql.test.ts inspects the SQL string. Neither notices when the two stop
 * agreeing about a COLUMN NAME — which is exactly what happened to the stage
 * marker: the query aliased `m.dims_stage AS stage` while `formatResults` read
 * `r.dims_stage`, so every recall line shipped `stage: null` and "the adjudicator
 * never ran" became unanswerable from the host. Both halves were green. The
 * byte-diff gate's container round-trip caught it.
 *
 * So these tests do not hand-write the row: they DERIVE its keys from the SELECT
 * list of the real query builders. A future rename on either side fails here.
 */
describe("the SQL → formatResults seam (row keys derived from the real SELECT list)", () => {
  /** The result-set key each SELECT item produces: its `AS` alias, else the bare column. */
  function selectedKeys(sql: string): string[] {
    const select = sql.slice(sql.indexOf("SELECT") + "SELECT".length, sql.indexOf("FROM"))
    return select
      .split(",")
      .map((item) => item.trim().replace(/\s+/g, " "))
      .filter((item) => item.length > 0)
      .map((item) => {
        const aliased = item.match(/\sAS\s+(\S+)$/i)
        const name = aliased ? aliased[1] : item
        return name.split(".").pop() as string
      })
  }

  /** A db row with EXACTLY the keys the query yields, each column's value plausible. */
  function rowFromKeys(keys: string[]): MemoryRow {
    const values: Record<string, unknown> = {
      id: 7,
      ts: "2026-07-31T00:00:00.000Z",
      source: "observe",
      provenance: "grounded",
      dims: '{"safety":0.6}',
      dims_a: '{"safety":0.4}',
      dims_c: '{"safety":0.8}',
      dims_stage: "base",
      tags: "a,b",
      text: "hull scraped",
      distance: 0.25,
    }
    const out: Record<string, unknown> = {}
    for (const k of keys) {
      expect(values).toHaveProperty(k) // an unknown key means the SELECT list drifted
      out[k] = values[k]
    }
    return out as unknown as MemoryRow
  }

  it("a knn row, keyed as the query actually returns it, renders stage='base'", () => {
    const keys = selectedKeys(buildKnnSql(5))
    const obj = JSON.parse(formatResults([rowFromKeys(keys)]))
    expect(obj.stage).toBe("base")
    expect(obj.dims).toEqual({ safety: 0.6 })
    expect(typeof obj.score).toBe("number")
  })

  it("a recent row, keyed as the query actually returns it, renders stage='base'", () => {
    const keys = selectedKeys(buildRecentSql(10))
    const obj = JSON.parse(formatResults([rowFromKeys(keys)]))
    expect(obj.stage).toBe("base")
    expect(obj).not.toHaveProperty("score") // recent does not embed
  })

  it("a pending row, keyed as the query actually returns it, carries both producers", () => {
    const keys = selectedKeys(buildPendingSql(25))
    const obj = JSON.parse(formatPending([rowFromKeys(keys)]))
    expect(obj).toEqual({ id: 7, text: "hull scraped", dims_a: { safety: 0.4 }, dims_c: { safety: 0.8 } })
  })
})
