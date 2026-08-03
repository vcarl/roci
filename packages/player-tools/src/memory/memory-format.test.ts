import { describe, it, expect, vi } from "vitest"
import {
  formatResults,
  formatPending,
  formatEmbeddings,
  decodeEmbedding,
  parseResults,
  parseEmbedResponse,
  RECALL_WIRE_VERSION,
  type MemoryRow,
} from "./memory-format.js"
import { EMBED_DIM, buildKnnSql, buildRecentSql, buildPendingSql } from "./memory-sql.js"

/**
 * What the `lineage` block looks like for a row whose lineage columns are
 * absent from the fixture entirely. `state: null` — NOT `"first"` and not
 * omitted: a dropped column must be visibly wrong rather than quietly plausible.
 */
const UNKNOWN_LINEAGE = { state: null, prior_id: null, distance: null, similarity: null }

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
      // dims_a/dims_c: null — the columns are absent from the fixture, and `wire`
      // is what says the CLI looked at all. A whole-object `toEqual` is the point
      // here: a field silently added to the wire fails this case by design.
      { id: 7, ts: "2026-06-30T01:00:00Z", source: "observe", provenance: "grounded", dims: { safety: 0.8 }, dims_a: null, dims_c: null, stage: null, lineage: UNKNOWN_LINEAGE, wire: RECALL_WIRE_VERSION, tags: ["place", "calm"], text: "the bar", score: 1 / 1.17 },
      { id: 3, ts: "2026-06-29T01:00:00Z", source: "promotion", provenance: "episodic", dims: null, dims_a: null, dims_c: null, stage: null, lineage: UNKNOWN_LINEAGE, wire: RECALL_WIRE_VERSION, tags: [], text: "a fight", score: 1 / 1.42 },
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

  /**
   * REVERSED at wire v2. This case used to assert the opposite — that search
   * rows withheld `dims_a`/`dims_c` because "recall needs the best vector only".
   * That was true of what recall RANKS with and false of what recall must be
   * ABLE TO EXPLAIN: with only the merged `dims` on the wire, the A and C stages
   * are algebraically unrecoverable from any recall, and the C stage was never
   * measured once. The cost the old comment feared was the 384-float embedding;
   * these are ~10-key axis vectors, and the embedding is still not here (it has
   * its own offline `embeddings` verb).
   */
  it("search rows DO carry dims_a / dims_c beside the merged vector", () => {
    const obj = JSON.parse(formatResults([row]))
    expect(obj.dims_a).toEqual({ safety: 0.4 })
    expect(obj.dims_c).toEqual({ safety: 0.8, "grumbling-tender": -0.4 })
    expect(obj.dims).toEqual({ safety: 0.6, "grumbling-tender": -0.4 })
    // Still NOT the embedding. That stays off every recall, by design.
    expect(obj).not.toHaveProperty("embedding")
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
      lineage_state: "scored",
      lineage_prior_id: 4,
      lineage_distance: 0.5,
      lineage_similarity: 0.875,
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

  /**
   * The v2 half of the same seam. `formatResults` now reads `dims_a`/`dims_c`,
   * so a SELECT list that omits them does not error — it renders `null`, which
   * is indistinguishable from a genuinely unscored stage. Deriving the row keys
   * from the real builders is what makes that omission fail here instead of
   * silently producing a column of nulls in a study six weeks later.
   */
  it("the recall SELECT lists actually carry dims_a and dims_c to the wire", () => {
    for (const [name, sql] of [
      ["knn", buildKnnSql(5)],
      ["recent", buildRecentSql(10)],
    ] as const) {
      const keys = selectedKeys(sql)
      expect(keys, name).toContain("dims_a")
      expect(keys, name).toContain("dims_c")
      const obj = JSON.parse(formatResults([rowFromKeys(keys)]))
      // Three DISTINCT vectors, each surviving under its own name: the whole
      // point is that A, C and the merged result can be told apart.
      expect(obj.dims, name).toEqual({ safety: 0.6 })
      expect(obj.dims_a, name).toEqual({ safety: 0.4 })
      expect(obj.dims_c, name).toEqual({ safety: 0.8 })
      expect(obj.wire, name).toBe(RECALL_WIRE_VERSION)
    }
  })

  /**
   * The v3 half of the same seam, and it matters more than the v2 half: every
   * lineage field is a SCALAR, so a SELECT list that drops one renders `null`
   * — a perfectly plausible "no near neighbour" that no parse error would ever
   * flag. Deriving the keys from the real builders is the only thing standing
   * between that and a study concluding a corpus is full of novel memories.
   */
  it("the recall SELECT lists actually carry all four lineage columns to the wire", () => {
    for (const [name, sql] of [
      ["knn", buildKnnSql(5)],
      ["recent", buildRecentSql(10)],
    ] as const) {
      const keys = selectedKeys(sql)
      for (const col of [
        "lineage_state",
        "lineage_prior_id",
        "lineage_distance",
        "lineage_similarity",
      ]) {
        expect(keys, `${name}/${col}`).toContain(col)
      }
      const obj = JSON.parse(formatResults([rowFromKeys(keys)]))
      expect(obj.lineage, name).toEqual({
        state: "scored",
        prior_id: 4,
        distance: 0.5,
        similarity: 0.875,
      })
    }
  })
})

/**
 * Wire v2 — the per-stage vectors, and the versioning that makes their absence
 * READABLE rather than merely tolerated.
 */
describe("wire v2 — per-stage vectors on the recall line", () => {
  const legacyRow = (over: Partial<MemoryRow> = {}): MemoryRow => ({
    id: 1,
    distance: 0.5,
    ts: "2026-07-24T01:47:38.947Z",
    source: "observe",
    provenance: "grounded",
    tags: null,
    text: "the hull scraped the debris ring",
    ...over,
  })

  it("a full round trip keeps A, C and the merged vector DISTINCT and intact", () => {
    const dims = { safety: 0.6, voyage: -0.25 }
    const dimsA = { safety: 0.4, voyage: -0.5 }
    const dimsC = { safety: 0.8, voyage: 0 }
    const parsed = parseResults(
      formatResults([
        legacyRow({
          dims: JSON.stringify(dims),
          dims_a: JSON.stringify(dimsA),
          dims_c: JSON.stringify(dimsC),
          dims_stage: "base",
        }),
      ]),
    )
    expect(parsed).toHaveLength(1)
    const hit = parsed[0]
    expect(hit.wire).toBe(RECALL_WIRE_VERSION)
    expect(hit.dims).toEqual(dims)
    expect(hit.dims_a).toEqual(dimsA)
    expect(hit.dims_c).toEqual(dimsC)
    expect(hit.stage).toBe("base")
    // Not merely equal to each other by accident — a formatter that emitted the
    // same object three times would pass every assertion above but measure nothing.
    expect(hit.dims_a).not.toEqual(hit.dims)
    expect(hit.dims_c).not.toEqual(hit.dims)
    expect(hit.dims_a).not.toEqual(hit.dims_c)
  })

  it("C renders null (never {}) when the pathway had no producer at all", () => {
    const hit = parseResults(
      formatResults([legacyRow({ dims: '{"safety":0.4}', dims_a: '{"safety":0.4}', dims_c: null })]),
    )[0]
    expect(hit.dims_c).toBeNull()
    expect(hit.dims_a).toEqual({ safety: 0.4 })
    // `{}` is a producer that scored every axis at zero. `null` is no producer.
    // The adjudicator already depends on the difference; so does any C study.
    const zeroed = parseResults(formatResults([legacyRow({ dims_c: "{}" })]))[0]
    expect(zeroed.dims_c).toEqual({})
  })

  it("a legacy row — empty dims, no stage, no producers — renders without throwing", () => {
    // The real pre-existing corpus: 825 rows whose db predates dims_stage/dims_a/
    // dims_c entirely. Post-migration the columns exist and are NULL, and `dims`
    // on those rows is NULL or empty.
    for (const empty of [null, undefined, ""] as const) {
      const line = formatResults([
        legacyRow({ dims: empty, dims_a: empty, dims_c: empty, dims_stage: null }),
      ])
      const hit = parseResults(line)[0]
      expect(hit.dims).toBeNull()
      expect(hit.dims_a).toBeNull()
      expect(hit.dims_c).toBeNull()
      expect(hit.stage).toBeNull()
      // Still a v2 line: the CLI looked and found nothing, which is a DIFFERENT
      // fact from a pre-v2 CLI that never looked.
      expect(hit.wire).toBe(RECALL_WIRE_VERSION)
      expect(hit).not.toHaveProperty("dims_parse_errors")
    }
  })

  it("a TORN producer column is reported, not silently shown as absence", () => {
    const hit = parseResults(
      formatResults([legacyRow({ dims: '{"safety":0.4}', dims_a: "{not json", dims_c: "[1,2]" })]),
    )[0]
    expect(hit.dims_a).toBeNull()
    expect(hit.dims_c).toBeNull()
    expect(hit.dims_parse_errors).toEqual(["dims_a", "dims_c"])
    // And it did NOT sink the recall: dims — the vector that actually ranks — is intact.
    expect(hit.dims).toEqual({ safety: 0.4 })
  })

  it("an unstamped (pre-v2) line parses, and its missing wire is the signal", () => {
    // Exactly what a stale provisioned bundle in a long-lived container emits.
    const v1Line = JSON.stringify({
      id: 9,
      ts: "2026-07-24T01:47:38.947Z",
      source: "observe",
      provenance: "grounded",
      dims: { safety: 0.6 },
      stage: "base",
      tags: [],
      text: "old bundle",
      score: 0.5,
    })
    const hit = parseResults(v1Line)[0]
    expect(hit.id).toBe(9)
    expect(hit.dims).toEqual({ safety: 0.6 })
    // Undefined, not null: nothing may default this, because "absent" is what
    // distinguishes "never transmitted" from "transmitted and empty".
    expect(hit.wire).toBeUndefined()
    expect(hit.dims_a).toBeUndefined()
    expect(hit.dims_c).toBeUndefined()
  })
})

describe("decodeEmbedding / formatEmbeddings", () => {
  /** The exact bytes sqlite-vec stores for a FLOAT[n]: little-endian float32s. */
  const blobOf = (values: number[]): Uint8Array => {
    const buf = new ArrayBuffer(values.length * 4)
    const view = new DataView(buf)
    for (let i = 0; i < values.length; i++) view.setFloat32(i * 4, values[i], true)
    return new Uint8Array(buf)
  }

  it("decodes to the EXACT stored float32s, not a re-rounded rendering", () => {
    const stored = [0.1, -0.25, 0.3333333, 0]
    const got = decodeEmbedding(blobOf(stored), 4)
    // float32 round-trip: 0.1 is 0.10000000149011612, NOT 0.1. Asserting the
    // exact float32 value is the point — `vec_to_json` would have printed
    // "0.100000" and lost the distinction between adjacent float32s.
    expect(got[0]).toBe(Math.fround(0.1))
    expect(got[0]).not.toBe(0.1)
    expect(got).toEqual(stored.map(Math.fround))
  })

  it("throws on bytes it cannot interpret, but not on an unexpected dimension", () => {
    // Uninterpretable → fatal.
    expect(() => decodeEmbedding(new Uint8Array(9))).toThrow(/not a whole number of float32s/)
    expect(() => decodeEmbedding("[0.1,0.2]")).toThrow(/not a blob/)
    // Asserted dimension → fatal for the callers that assert one.
    expect(() => decodeEmbedding(blobOf([1, 2, 3]), 4)).toThrow(/3 float32s\); expected 4/)
    // Derived dimension → reported, not fatal. The dump keeps going.
    expect(decodeEmbedding(blobOf([1, 2, 3]))).toEqual([1, 2, 3])
  })

  it("renders one NDJSON row per embedding, carrying its own derived dim", () => {
    const lines = formatEmbeddings([
      { id: 4, embedding: blobOf([0.5, 0.25]) },
      { id: 9, embedding: blobOf(new Array(EMBED_DIM).fill(0.125)) },
    ]).split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toEqual({ id: 4, dim: 2, embedding: [0.5, 0.25] })
    const wide = JSON.parse(lines[1])
    expect(wide.dim).toBe(EMBED_DIM)
    expect(wide.embedding).toHaveLength(EMBED_DIM)
  })
})

/**
 * Wire v3 — lineage on the recall line, and the four states that must never
 * collapse into each other.
 */
describe("wire v3 — lineage on the recall line", () => {
  const row = (over: Partial<MemoryRow> = {}): MemoryRow => ({
    id: 486,
    distance: 0.4,
    ts: "2026-08-03T01:00:00.000Z",
    source: "orient",
    provenance: "inferred",
    tags: null,
    text: "CPU remains bottlenecked at 2/12",
    ...over,
  })

  it("a scored row carries the prior, the raw distance and the raw cosine", () => {
    const obj = JSON.parse(
      formatResults([
        row({
          lineage_state: "scored",
          lineage_prior_id: 234,
          lineage_distance: 0.5678,
          lineage_similarity: 0.83879,
        }),
      ]),
    )
    expect(obj.lineage).toEqual({
      state: "scored",
      prior_id: 234,
      // UNROUNDED, both of them. The whole value of this field is that an
      // analyst can re-threshold it; a rounded similarity cannot be.
      distance: 0.5678,
      similarity: 0.83879,
    })
    expect(obj.wire).toBe(3)
  })

  it("a PRE-LINEAGE row reads as `legacy` — unknown, and NOT as 'restated nothing'", () => {
    // The 825-row corpus that already exists. The migration backfills the state
    // to 'legacy' and leaves the three value columns NULL.
    const obj = JSON.parse(formatResults([row({ lineage_state: "legacy" })]))
    expect(obj.lineage.state).toBe("legacy")
    expect(obj.lineage.prior_id).toBeNull()
    expect(obj.lineage.similarity).toBeNull()
    // The distinction this whole design turns on.
    expect(obj.lineage.state).not.toBe("first")
  })

  it("`first`, `unknown` and `legacy` stay three different values on the wire", () => {
    const states = ["first", "unknown", "legacy"].map(
      (s) => JSON.parse(formatResults([row({ lineage_state: s })])).lineage,
    )
    // All three have a null prior — which is exactly why the STATE has to
    // carry the meaning, and why nothing may infer it from the nulls.
    for (const l of states) expect(l.prior_id).toBeNull()
    expect(new Set(states.map((l) => l.state)).size).toBe(3)
  })

  it("a dropped column renders `state: null`, not a plausible substitute", () => {
    // lineage_state is NOT NULL DEFAULT 'legacy' in the schema, so the only way
    // to reach a null here is a SELECT list that forgot it. Substituting
    // 'legacy' would hide a real bug behind a real-looking value.
    const obj = JSON.parse(formatResults([row()]))
    expect(obj.lineage.state).toBeNull()
  })

  it("a real PRE-v3 line parses, and `lineage` comes back UNDEFINED, not null", () => {
    // A long-lived container still running a v2 provisioned bundle. `undefined`
    // is the signal the host keys "never transmitted" off; a null would be
    // indistinguishable from a transmitted-but-empty block.
    const v2Line = JSON.stringify({
      id: 486,
      ts: "2026-08-03T01:00:00.000Z",
      source: "orient",
      provenance: "inferred",
      dims: { safety: 0.2 },
      dims_a: { safety: 0.2 },
      dims_c: null,
      stage: "base",
      tags: [],
      text: "CPU remains bottlenecked at 2/12",
      wire: 2,
    })
    const [parsed] = parseResults(v2Line)
    expect(parsed.wire).toBe(2)
    expect(parsed.lineage).toBeUndefined()
    expect(parsed).not.toHaveProperty("lineage")
  })

  it("non-finite stored values degrade to null rather than riding the wire as NaN", () => {
    const obj = JSON.parse(
      formatResults([
        row({
          lineage_state: "scored",
          lineage_prior_id: 234,
          lineage_distance: Number.NaN,
          lineage_similarity: Number.POSITIVE_INFINITY,
        }),
      ]),
    )
    // JSON.stringify would render both as `null` anyway; doing it explicitly
    // means the host's own null-check is the ONLY reading, in both directions.
    expect(obj.lineage.distance).toBeNull()
    expect(obj.lineage.similarity).toBeNull()
    expect(obj.lineage.state).toBe("scored")
  })
})
