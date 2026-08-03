import { describe, it, expect, vi } from "vitest"
import { runMemory, type MemoryDb, type MemoryStatement, type MemoryDeps } from "./memory-run.js"
import { formatResults, type MemoryRow } from "./memory-format.js"
import { classify } from "./memory-provenance.js"
import {
  PROMOTE_MARK_KEY,
  buildInsertSql,
  buildMetaGetSql,
  buildMetaSetSql,
  buildAdjudicateSql,
  buildNearestPriorSql,
  buildEmbeddingsSql,
} from "./memory-sql.js"

/** A record of one prepared-statement `.run()` (the write path). */
interface RunCall {
  sql: string
  args: unknown[]
}

/**
 * Minimal fake of the bun:sqlite surface `runMemory` uses. Records write calls
 * and serves preset read rows so the dispatch is exercised without a real db
 * (bun:sqlite + vec0.so are container-only, spec §4/risk 4).
 */
class FakeDb implements MemoryDb {
  runs: RunCall[] = []
  queries: { sql: string; args: unknown[] }[] = []
  allRows: Array<Record<string, unknown>> = []
  getRow: Record<string, unknown> | undefined = undefined
  /**
   * A real (if tiny) key/value `meta` table. The axis-gloss cache is a
   * write-then-read-back-on-the-NEXT-invocation contract, so a fake that only
   * ever served a fixed `getRow` could not tell "cached" from "re-embedded".
   * Falls back to `getRow` for keys nothing has written (the mark-get tests).
   */
  meta = new Map<string, string>()
  /**
   * What the write-time nearest-prior KNN returns. `[]` — the default — is an
   * EMPTY STORE, which is the honest state for a fake with nothing in it and
   * yields `lineage_state = 'first'`.
   */
  priorRows: Array<Record<string, unknown>> = []
  /** Stored embeddings by id, served back as float32 blobs for the lineage cosine. */
  vectors = new Map<number, ReadonlyArray<number>>()
  /** Set to throw from the nearest-prior lookup, to prove a write still lands. */
  priorLookupError: Error | null = null
  private nextRowId = 1

  private readMeta(sql: string, args: unknown[]): Record<string, unknown> | undefined {
    if (sql === buildMetaGetSql()) {
      const v = this.meta.get(String(args[0]))
      if (v !== undefined) return { value: v }
    }
    return this.getRow
  }

  prepare(sql: string): MemoryStatement {
    return {
      run: (...args: unknown[]) => {
        this.runs.push({ sql, args })
        if (sql === buildMetaSetSql()) this.meta.set(String(args[0]), String(args[1]))
        return { lastInsertRowid: this.nextRowId++ }
      },
      all: () => {
        throw new Error("unexpected .all on prepared statement")
      },
      get: (...args: unknown[]) => {
        this.queries.push({ sql, args })
        return this.readMeta(sql, args)
      },
    }
  }

  query(sql: string): MemoryStatement {
    return {
      run: () => {
        throw new Error("unexpected .run on query")
      },
      all: (...args: unknown[]) => {
        this.queries.push({ sql, args })
        // The two lineage reads are dispatched by SQL so the write path can be
        // exercised for real; everything else keeps the preset `allRows`.
        if (sql === buildNearestPriorSql()) {
          if (this.priorLookupError) throw this.priorLookupError
          return this.priorRows
        }
        const embMatch = sql.match(/WHERE id IN \((\d+)\)/)
        if (sql.startsWith("SELECT id, embedding FROM memories_vec") && embMatch) {
          const id = Number(embMatch[1])
          const v = this.vectors.get(id)
          if (!v) return []
          return [{ id, embedding: new Uint8Array(Float32Array.from(v).buffer) }]
        }
        return this.allRows
      },
      get: (...args: unknown[]) => {
        this.queries.push({ sql, args })
        return this.readMeta(sql, args)
      },
    }
  }
}

/** The bind arrays of every `INSERT INTO memories` (not the vec/meta writes). */
const inserts = (db: FakeDb): unknown[][] =>
  db.runs.filter((r) => r.sql === buildInsertSql()).map((r) => r.args)

/** The bind arrays of every meta upsert. */
const metaSets = (db: FakeDb): unknown[][] =>
  db.runs.filter((r) => r.sql === buildMetaSetSql()).map((r) => r.args)

/** The bind arrays of every adjudication UPDATE. */
const updates = (db: FakeDb): unknown[][] =>
  db.runs.filter((r) => r.sql === buildAdjudicateSql()).map((r) => r.args)

/** Everything written to a sink mock, joined — for message assertions. */
const text = (sink: { mock: { calls: unknown[][] } }): string =>
  sink.mock.calls.map((c) => String(c[0])).join("\n")

const VEC = [0.1, 0.2, 0.3]

function makeDeps(db: FakeDb, over: Partial<MemoryDeps> = {}) {
  const out = vi.fn()
  const err = vi.fn()
  const embed = vi.fn(async (_text: string) => VEC)
  const deps: MemoryDeps = {
    db,
    embed,
    nowIso: () => "2026-07-22T00:00:00.000Z",
    readStdin: async () => "",
    // Default: no artifacts on disk → the axis list is empty → A is inert, so
    // the stored base is exactly what the caller passed. That is the phase-1
    // behaviour the pre-existing cases below assert.
    axes: { readAxisArtifacts: () => null },
    out,
    err,
    ...over,
  }
  return { deps, out, err, embed }
}

describe("runMemory / remember", () => {
  it("embeds, inserts the row + vector with the objective provenance, and prints the id", async () => {
    const db = new FakeDb()
    const { deps, out, embed } = makeDeps(db)
    const code = await runMemory(
      ["remember", "a quiet station", "--tags", "a,b", "--source", "observe", "--dims-c", '{"curiosity":3}'],
      deps,
    )
    expect(code).toBe(0)
    expect(embed).toHaveBeenCalledWith("a quiet station")
    // Insert bind order: ts, source, tags(joined), text, provenance, dims(json),
    // dims_a, dims_c, dims_stage. This harness has no axis artifacts, so A is the
    // empty vector and the ⊕ merge leaves C standing alone as the base.
    expect(db.runs[0].args).toEqual([
      "2026-07-22T00:00:00.000Z",
      "observe",
      "a,b",
      "a quiet station",
      classify("observe"), // "grounded" — objective, from the write path
      '{"curiosity":3}',
      "{}",
      '{"curiosity":3}',
      "base",
      // Lineage: this fake store is empty, so the lookup honestly reports
      // `first` — the ONE state that means "nothing was restated" — with no
      // prior, distance or similarity.
      "first",
      null,
      null,
      null,
    ])
    // Vector insert: id, JSON-stringified embedding.
    expect(db.runs[1].args).toEqual([1, JSON.stringify(VEC)])
    expect(out).toHaveBeenCalledWith("1")
  })

  it("defaults source to 'conscious' (→ asserted) and tags/dims_c to null when absent", async () => {
    const db = new FakeDb()
    const { deps } = makeDeps(db)
    await runMemory(["remember", "unsourced note"], deps)
    expect(db.runs[0].args).toEqual([
      "2026-07-22T00:00:00.000Z",
      "conscious",
      null,
      "unsourced note",
      classify("conscious"), // "asserted"
      // No producer AND no axis artifacts → both computed vectors are empty
      // objects. dims_c stays NULL: "the pathway had no producer" is a different
      // fact from "the producer scored nothing", and only the column can say so.
      "{}",
      "{}",
      null,
      "base",
      "first",
      null,
      null,
      null,
    ])
  })
})

describe("runMemory / search", () => {
  const rows: MemoryRow[] = [
    { id: 5, ts: "t5", source: "observe", provenance: "grounded", dims: null, tags: "a,b", text: "five", distance: 0.5 },
    { id: 6, ts: "t6", source: "orient", provenance: "inferred", dims: '{"x":1}', tags: "c", text: "six", distance: 1 },
  ]

  it("emits EXACTLY the formatResults NDJSON shape (byte-compat, risk #1)", async () => {
    const db = new FakeDb()
    db.allRows = rows as unknown as Array<Record<string, unknown>>
    const { deps, out } = makeDeps(db)
    const code = await runMemory(["search", "quiet", "-k", "5"], deps)
    expect(code).toBe(0)
    // The single source of the wire format — assert byte-identical, not shape.
    expect(out).toHaveBeenCalledWith(formatResults(rows))
    // KNN SQL is the tested builder (buildKnnSql), not a hand-copy.
    expect(db.queries[0].sql).toContain("v.embedding MATCH ? AND k = 5")
    expect(db.queries[0].args).toEqual([JSON.stringify(VEC)])
  })

  it("over-fetches then post-filters by tag intersection and truncates to k", async () => {
    const db = new FakeDb()
    db.allRows = rows as unknown as Array<Record<string, unknown>>
    const { deps, out } = makeDeps(db)
    await runMemory(["search", "quiet", "-k", "1", "--tags", "c"], deps)
    // Over-fetch multiplier applied in the SQL (k=1 * TAG_OVERFETCH=8).
    expect(db.queries[0].sql).toContain("AND k = 8")
    // Only row 6 carries tag "c"; result truncates to k=1.
    const only = [rows[1]]
    expect(out).toHaveBeenCalledWith(formatResults(only))
  })
})

describe("runMemory / recent", () => {
  it("selects newest-first with the -n limit and emits NDJSON without a score", async () => {
    const recentRows: MemoryRow[] = [
      { id: 9, ts: "t9", source: "conscious", provenance: "asserted", dims: null, tags: null, text: "nine" },
    ]
    const db = new FakeDb()
    db.allRows = recentRows as unknown as Array<Record<string, unknown>>
    const { deps, out } = makeDeps(db)
    await runMemory(["recent", "-n", "3"], deps)
    expect(db.queries[0].sql).toContain("ORDER BY id DESC LIMIT 3")
    const emitted = out.mock.calls[0][0] as string
    expect(emitted).toBe(formatResults(recentRows))
    // recent does not embed → no score field.
    expect(emitted).not.toContain('"score"')
  })
})

describe("runMemory / mark-get + mark-set", () => {
  it("prints the stored mark value when present", async () => {
    const db = new FakeDb()
    db.getRow = { value: '{"len":42,"hash":"abc"}' }
    const { deps, out } = makeDeps(db)
    await runMemory(["mark-get"], deps)
    expect(out).toHaveBeenCalledWith('{"len":42,"hash":"abc"}')
  })

  it("prints nothing when no mark is stored", async () => {
    const db = new FakeDb()
    db.getRow = undefined
    const { deps, out } = makeDeps(db)
    await runMemory(["mark-get"], deps)
    expect(out).not.toHaveBeenCalled()
  })

  it("persists the high-water mark verbatim under the promote key", async () => {
    const db = new FakeDb()
    const { deps } = makeDeps(db)
    await runMemory(["mark-set", '{"len":7}'], deps)
    expect(db.runs[0].args).toEqual([PROMOTE_MARK_KEY, '{"len":7}'])
  })
})

describe("runMemory / promote", () => {
  it("embeds + inserts each base64 stdin line as source='promotion' and prints the count", async () => {
    const db = new FakeDb()
    const line1 = Buffer.from("first entry", "utf8").toString("base64")
    const line2 = Buffer.from("second entry", "utf8").toString("base64")
    const { deps, out, embed } = makeDeps(db, { readStdin: async () => `${line1}\n${line2}\n` })
    const code = await runMemory(["promote"], deps)
    expect(code).toBe(0)
    expect(embed).toHaveBeenNthCalledWith(1, "first entry")
    expect(embed).toHaveBeenNthCalledWith(2, "second entry")
    // Each row: (ts, "promotion", "promotion", text, episodic, dims, dims_a, null, base)
    // then vec insert. Pathway 5 has no producer, and this harness has no axis
    // artifacts, so both computed vectors are empty and dims_c is NULL.
    expect(db.runs[0].args).toEqual([
      "2026-07-22T00:00:00.000Z",
      "promotion",
      "promotion",
      "first entry",
      classify("promotion"), // "episodic"
      "{}",
      "{}",
      null,
      "base",
      "first",
      null,
      null,
      null,
    ])
    expect(out).toHaveBeenCalledWith("2")
  })
})

describe("phase 2 — the A stage runs inside the CLI on every insert", () => {
  const PALETTE = "😫 😮‍💨 😐 🤩 🚀 # burdened → exhilarated"
  const DRIVES = "- safety — your physical integrity"
  const ARTIFACTS = { readAxisArtifacts: () => ({ palette: PALETTE, drives: DRIVES }) }

  // A deterministic stub embed: the memory text and the glosses map onto a tiny
  // orthogonal basis so the expected cosines are exact.
  const BASIS: Record<string, number[]> = {
    "hull breached": [1, 0, 0],
    "safety: your physical integrity": [1, 0, 0],
    exhilarated: [0, 1, 0],
    burdened: [0, 0, 1],
  }
  const embed = async (t: string): Promise<number[]> => BASIS[t] ?? [0, 0, 0]

  it("remember with NO producer vector still stores one — pathway 6 is never dimensionless", async () => {
    const db = new FakeDb()
    const { deps } = makeDeps(db, { embed, axes: ARTIFACTS })
    const code = await runMemory(["remember", "hull breached", "--source", "conscious"], deps)
    expect(code).toBe(0)
    const insert = inserts(db)[0]
    // binds: ts, source, tags, text, provenance, dims, dims_a, dims_c, dims_stage
    expect(JSON.parse(insert[5] as string)).toEqual({ safety: 1, "burdened-exhilarated": 0 })
    expect(JSON.parse(insert[6] as string)).toEqual({ safety: 1, "burdened-exhilarated": 0 })
    expect(insert[7]).toBeNull()
    expect(insert[8]).toBe("base")
  })

  it("remember WITH --dims-c writes the per-axis mean and retains both producers", async () => {
    const db = new FakeDb()
    const { deps } = makeDeps(db, { embed, axes: ARTIFACTS })
    const code = await runMemory(
      ["remember", "hull breached", "--source", "observe", "--dims-c", '{"safety":0.4}'],
      deps,
    )
    expect(code).toBe(0)
    const insert = inserts(db)[0]
    expect(JSON.parse(insert[5] as string)).toEqual({ safety: 0.7, "burdened-exhilarated": 0 })
    expect(JSON.parse(insert[6] as string)).toEqual({ safety: 1, "burdened-exhilarated": 0 })
    expect(JSON.parse(insert[7] as string)).toEqual({ safety: 0.4 })
    expect(insert[8]).toBe("base")
  })

  it("keeps a producer key the CLI's axis list does not know — union, not intersection", async () => {
    const db = new FakeDb()
    const { deps } = makeDeps(db, { embed, axes: { readAxisArtifacts: () => null } })
    await runMemory(["remember", "hull breached", "--source", "observe", "--dims-c", '{"voyage":0.6}'], deps)
    const insert = inserts(db)[0]
    expect(JSON.parse(insert[5] as string)).toEqual({ voyage: 0.6 })
    expect(JSON.parse(insert[6] as string)).toEqual({})
    expect(JSON.parse(insert[7] as string)).toEqual({ voyage: 0.6 })
  })

  it("warns on stderr when it cannot read the axis artifacts — a quiet A is a defect", async () => {
    const db = new FakeDb()
    const { deps, err } = makeDeps(db, { embed, axes: { readAxisArtifacts: () => null } })
    await runMemory(["remember", "hull breached", "--source", "conscious"], deps)
    expect(text(err)).toMatch(/axis/i)
  })

  it("embeds each gloss ONCE and caches the table in meta", async () => {
    const calls: string[] = []
    const counting = async (t: string): Promise<number[]> => {
      calls.push(t)
      return BASIS[t] ?? [0, 0, 0]
    }
    const db = new FakeDb()
    const { deps } = makeDeps(db, { embed: counting, axes: ARTIFACTS })
    await runMemory(["remember", "hull breached", "--source", "conscious"], deps)
    await runMemory(["remember", "hull breached", "--source", "conscious"], deps)
    // 3 glosses + 2 memory texts = 5; the second insert reuses the cached table.
    expect(calls.filter((t) => t !== "hull breached")).toEqual([
      "safety: your physical integrity",
      "exhilarated",
      "burdened",
    ])
    expect(metaSets(db).some(([k]) => k === "axis_gloss_v1")).toBe(true)
  })

  it("re-embeds the glosses when the axis fingerprint changes", async () => {
    const calls: string[] = []
    const counting = async (t: string): Promise<number[]> => {
      calls.push(t)
      return BASIS[t] ?? [0, 0, 0]
    }
    let palette = PALETTE
    const db = new FakeDb()
    const { deps } = makeDeps(db, {
      embed: counting,
      axes: { readAxisArtifacts: () => ({ palette, drives: DRIVES }) },
    })
    await runMemory(["remember", "hull breached", "--source", "conscious"], deps)
    palette = `${PALETTE}\n🤨 😑 😶 🧐 🔭 # cynical → curious`
    await runMemory(["remember", "hull breached", "--source", "conscious"], deps)
    expect(calls).toContain("curious")
    expect(calls).toContain("cynical")
  })

  it("promote gets A too — pathway 5 has no producer but is never dimensionless", async () => {
    const db = new FakeDb()
    const { deps } = makeDeps(db, {
      embed,
      axes: ARTIFACTS,
      readStdin: async () => Buffer.from("hull breached", "utf8").toString("base64"),
    })
    const code = await runMemory(["promote"], deps)
    expect(code).toBe(0)
    const insert = inserts(db)[0]
    expect(JSON.parse(insert[5] as string)).toEqual({ safety: 1, "burdened-exhilarated": 0 })
    expect(insert[7]).toBeNull()
    expect(insert[8]).toBe("base")
  })

  it("the retired --dims flag exits 2 without writing a row", async () => {
    // The codec rejects it; this pins that the CLI surfaces that as a usage exit
    // rather than storing a producer-less row that looks exactly like pathway 6.
    const db = new FakeDb()
    const { deps, err } = makeDeps(db, { embed, axes: ARTIFACTS })
    const code = await runMemory(
      ["remember", "hull breached", "--source", "observe", "--dims", '{"safety":0.4}'],
      deps,
    )
    expect(code).toBe(2)
    expect(inserts(db)).toEqual([])
    expect(text(err)).toContain("--dims-c")
  })

  /** Embeds the memory text fine but fails every gloss — the cold-start / flaky
   *  embed-server case, which only bites on a cache miss (first write, or first
   *  write after a PALETTE.md / DRIVES.md edit). */
  const glossEmbedFails = async (t: string): Promise<number[]> => {
    if (t === "hull breached") return [1, 0, 0]
    throw new Error("embed request failed after 7 attempts: connect ECONNREFUSED")
  }

  it("a failed gloss embed degrades A — it must NEVER lose the memory", async () => {
    const db = new FakeDb()
    const { deps, err } = makeDeps(db, { embed: glossEmbedFails, axes: ARTIFACTS })
    const code = await runMemory(
      ["remember", "hull breached", "--source", "observe", "--dims-c", '{"safety":0.4}'],
      deps,
    )
    expect(code).toBe(0)
    const insert = inserts(db)[0]
    // The producer's vector survives intact; A is inert for this row.
    expect(JSON.parse(insert[5] as string)).toEqual({ safety: 0.4 })
    // dims_a = '{}' is the DURABLE signal — the stderr warning below is invisible
    // to the host on a zero exit, but this column stays queryable forever.
    expect(JSON.parse(insert[6] as string)).toEqual({})
    // A half-embedded table must never be cached: the next write retries cleanly.
    expect(metaSets(db)).toEqual([])
    expect(text(err)).toMatch(/gloss|embed/i)
  })

  it("a failed gloss embed does not sink a promotion batch either", async () => {
    const db = new FakeDb()
    const { deps } = makeDeps(db, {
      embed: glossEmbedFails,
      axes: ARTIFACTS,
      readStdin: async () => Buffer.from("hull breached", "utf8").toString("base64"),
    })
    const code = await runMemory(["promote"], deps)
    expect(code).toBe(0)
    expect(JSON.parse(inserts(db)[0][6] as string)).toEqual({})
  })

  it("a malformed PALETTE.md does not sink the write — A degrades, the row still lands", async () => {
    const db = new FakeDb()
    const { deps, err } = makeDeps(db, {
      embed,
      axes: { readAxisArtifacts: () => ({ palette: "😐 😐 😐 😐 😐 #  → tender", drives: DRIVES }) },
    })
    const code = await runMemory(
      ["remember", "hull breached", "--source", "observe", "--dims-c", '{"safety":0.4}'],
      deps,
    )
    expect(code).toBe(0)
    expect(JSON.parse(inserts(db)[0][5] as string)).toEqual({ safety: 0.4 })
    expect(text(err)).toMatch(/palette|axis/i)
  })
})

describe("phase 2 — pending and adjudicate", () => {
  it("pending prints the base-stage queue as NDJSON with both producer vectors", async () => {
    const db = new FakeDb()
    db.allRows = [{ id: 3, text: "hull breached", dims_a: '{"safety":1}', dims_c: '{"safety":0.4}' }]
    const { deps, out } = makeDeps(db)
    const code = await runMemory(["pending", "-n", "5"], deps)
    expect(code).toBe(0)
    expect(JSON.parse(out.mock.calls[0][0] as string)).toEqual({
      id: 3,
      text: "hull breached",
      dims_a: { safety: 1 },
      dims_c: { safety: 0.4 },
    })
    expect(db.queries[0].sql).toContain("WHERE dims_stage = 'base' ORDER BY id ASC LIMIT 5")
  })

  it("adjudicate writes the vector over the base and flips the stage", async () => {
    const db = new FakeDb()
    const { deps } = makeDeps(db)
    const code = await runMemory(["adjudicate", "3", '{"safety":0.9}'], deps)
    expect(code).toBe(0)
    expect(updates(db)[0]).toEqual(['{"safety":0.9}', 3])
    // The stage flip is a literal in the builder, not a bind — pin it here so a
    // row can never be adjudicated while still sitting in the work queue.
    expect(db.runs[0].sql).toContain("dims_stage = 'adjudicated'")
  })

  it("a malformed adjudicate vector exits 2 without touching the row", async () => {
    const db = new FakeDb()
    const { deps } = makeDeps(db)
    const code = await runMemory(["adjudicate", "3", "{nope"], deps)
    expect(code).toBe(2)
    expect(updates(db)).toEqual([])
  })
})

/**
 * The embedding readback verb. The vectors have been written since day one and
 * nothing has ever selected them; every offline study re-embedded the corpus
 * with whatever model was live THAT day, which is why none of them reproduced.
 */
describe("runMemory / embeddings", () => {
  /** The exact bytes sqlite-vec stores for a FLOAT[n] column. */
  const blobOf = (values: number[]): Uint8Array => {
    const buf = new ArrayBuffer(values.length * 4)
    const view = new DataView(buf)
    for (let i = 0; i < values.length; i++) view.setFloat32(i * 4, values[i], true)
    return new Uint8Array(buf)
  }

  it("dumps the stored vectors as NDJSON, one row per line", async () => {
    const db = new FakeDb()
    db.allRows = [
      { id: 2, embedding: blobOf([0.25, -0.5]) },
      { id: 5, embedding: blobOf([1, 0]) },
    ]
    const { deps, out, embed } = makeDeps(db)
    const code = await runMemory(["embeddings", "--ids", "5,2", "-n", "10"], deps)
    expect(code).toBe(0)
    // Read-only and offline: it must never call the embedder. A verb that
    // re-embedded to answer "what is stored" would be the bug it exists to fix.
    expect(embed).not.toHaveBeenCalled()
    const lines = (out.mock.calls[0][0] as string).split("\n")
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { id: 2, dim: 2, embedding: [0.25, -0.5] },
      { id: 5, dim: 2, embedding: [1, 0] },
    ])
    // ids become SQL literals (vec0's read path has no bind seam) — deduped and
    // sorted by the builder, and bound to nothing.
    expect(db.queries[0].sql).toContain("WHERE id IN (2, 5)")
    expect(db.queries[0].sql).toContain("LIMIT 10")
    expect(db.queries[0].args).toEqual([])
  })

  it("without --ids or -n it scans the whole table, uncapped", async () => {
    const db = new FakeDb()
    db.allRows = []
    const { deps } = makeDeps(db)
    expect(await runMemory(["embeddings"], deps)).toBe(0)
    expect(db.queries[0].sql).toBe("SELECT id, embedding FROM memories_vec ORDER BY id ASC")
  })

  it("rejects a non-integer id before it can reach the SQL", async () => {
    const db = new FakeDb()
    const { deps, err } = makeDeps(db)
    expect(await runMemory(["embeddings", "--ids", "3,1 OR 1=1"], deps)).toBe(2)
    expect(db.queries).toEqual([])
    expect(text(err)).toMatch(/positive integers/)
  })
})

describe("runMemory / usage", () => {
  it("errors with exit 2 on an unknown verb", async () => {
    const db = new FakeDb()
    const { deps, err } = makeDeps(db)
    const code = await runMemory(["frobnicate"], deps)
    expect(code).toBe(2)
    expect(err).toHaveBeenCalled()
  })
})

/**
 * LINEAGE — what a memory restated at the moment it was written.
 *
 * The container e2e (byte-diff gate + the task report) is what proves the KNN
 * picks the RIGHT neighbour, because that is sqlite-vec's job and a fake cannot
 * demonstrate it. What these cases pin is everything that IS this module's job
 * and that no runtime error would report: the query runs before the insert, the
 * four values land in the right bind slots, and a failure degrades to `unknown`
 * rather than to `first` or to a lost memory.
 */
describe("lineage — computed at write time, never blocking the write", () => {
  const PRIOR_VEC = [0.11, 0.19, 0.31]

  const scoredDb = (): FakeDb => {
    const db = new FakeDb()
    db.priorRows = [{ id: 42, distance: 0.0141 }]
    db.vectors.set(42, PRIOR_VEC)
    return db
  }

  it("runs the nearest-prior lookup BEFORE the row's own insert", async () => {
    // The single invariant the whole feature rests on. Run it after the insert
    // and the memory becomes its own nearest neighbour at distance 0, and every
    // row in the store reads as a perfect restatement of itself.
    const db = scoredDb()
    const { deps } = makeDeps(db)
    await runMemory(["remember", "a quiet station"], deps)
    const lookupOrder = db.queries.findIndex((q) => q.sql === buildNearestPriorSql())
    expect(lookupOrder).toBeGreaterThanOrEqual(0)
    // Nothing was inserted before the lookup ran.
    expect(db.runs.filter((r) => r.sql === buildInsertSql())).toHaveLength(1)
    const queriedBeforeInsert = db.queries.slice(0, lookupOrder + 1)
    expect(queriedBeforeInsert.some((q) => q.sql === buildInsertSql())).toBe(false)
  })

  it("stores state/prior/distance/similarity in the last four bind slots, in order", async () => {
    const db = scoredDb()
    const { deps } = makeDeps(db)
    await runMemory(["remember", "a quiet station"], deps)
    const args = inserts(db)[0]
    const [state, priorId, distance, similarity] = args.slice(-4)
    expect(state).toBe("scored")
    expect(priorId).toBe(42)
    expect(distance).toBeCloseTo(0.0141, 6)
    // The cosine is computed from the STORED vector read back out of the vec
    // table, not derived from the distance — so it is a real number here, and it
    // is high because PRIOR_VEC is a near-duplicate of VEC.
    expect(similarity as number).toBeGreaterThan(0.99)
    // Distance and similarity are DIFFERENT numbers in different slots. A
    // transposition would leave both plausible and both wrong.
    expect(distance).not.toBe(similarity)
  })

  it("a novel memory and a near-duplicate get separated similarities", async () => {
    const near = scoredDb()
    await runMemory(["remember", "a quiet station"], makeDeps(near).deps)

    const novel = new FakeDb()
    novel.priorRows = [{ id: 42, distance: 1.3 }]
    // Nearly orthogonal to VEC = [0.1, 0.2, 0.3].
    novel.vectors.set(42, [0.3, -0.2, 0.0333333])
    await runMemory(["remember", "a quiet station"], makeDeps(novel).deps)

    const nearSim = inserts(near)[0].at(-1) as number
    const novelSim = inserts(novel)[0].at(-1) as number
    expect(nearSim).toBeGreaterThan(0.99)
    expect(Math.abs(novelSim)).toBeLessThan(0.05)
  })

  it("an EMPTY store is `first` — the one state that means nothing was restated", async () => {
    const db = new FakeDb() // priorRows defaults to []
    const { deps } = makeDeps(db)
    await runMemory(["remember", "the very first memory"], deps)
    expect(inserts(db)[0].slice(-4)).toEqual(["first", null, null, null])
  })

  it("a FAILING lookup records `unknown`, still writes the memory, and is not `first`", async () => {
    const db = new FakeDb()
    db.priorLookupError = new Error("vec0 exploded")
    const { deps, out, err } = makeDeps(db)
    const code = await runMemory(["remember", "a memory worth keeping"], deps)
    // The write is the thing that must survive.
    expect(code).toBe(0)
    expect(out).toHaveBeenCalledWith("1")
    const args = inserts(db)[0]
    expect(args[3]).toBe("a memory worth keeping")
    expect(args.slice(-4)).toEqual(["unknown", null, null, null])
    // "we could not find out" must never be readable as "there was nothing".
    expect(args.at(-4)).not.toBe("first")
    expect(text(err)).toContain("recording lineage as unknown")
  })

  it("a scored row whose prior vector is unreadable keeps the prior, loses only the cosine", async () => {
    const db = new FakeDb()
    db.priorRows = [{ id: 42, distance: 0.5 }]
    // No entry in db.vectors → the readback returns nothing.
    const { deps } = makeDeps(db)
    await runMemory(["remember", "a quiet station"], deps)
    // Still `scored`: the neighbour and the raw metric are real; only the
    // DERIVED value is missing, and downgrading the state would discard facts.
    expect(inserts(db)[0].slice(-4)).toEqual(["scored", 42, 0.5, null])
  })

  it("promote computes lineage per entry, so entries in one batch can restate each other", async () => {
    const db = scoredDb()
    const l1 = Buffer.from("first entry", "utf8").toString("base64")
    const l2 = Buffer.from("second entry", "utf8").toString("base64")
    const { deps } = makeDeps(db, { readStdin: async () => `${l1}\n${l2}\n` })
    await runMemory(["promote"], deps)
    const lookups = db.queries.filter((q) => q.sql === buildNearestPriorSql())
    // Two entries, two lookups. Hoisting the lookup out of the loop would make
    // entry 2 blind to entry 1 — and a diary tail is exactly where consecutive
    // entries restate one another.
    expect(lookups).toHaveLength(2)
    expect(inserts(db)).toHaveLength(2)
    for (const args of inserts(db)) expect(args.at(-4)).toBe("scored")
  })

  it("the `embeddings` readback for the cosine never calls the embedder again", async () => {
    const db = scoredDb()
    const { deps, embed } = makeDeps(db)
    await runMemory(["remember", "a quiet station"], deps)
    // Exactly one embed: the memory's own. The prior's vector is READ, not
    // recomputed — recomputing it would silently re-baseline lineage onto
    // whatever embedding model happens to be live today.
    expect(embed).toHaveBeenCalledTimes(1)
    expect(db.queries.some((q) => q.sql === buildEmbeddingsSql({ ids: [42] }))).toBe(true)
  })
})
