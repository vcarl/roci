import { describe, it, expect, vi } from "vitest"
import { runMemory, type MemoryDb, type MemoryStatement, type MemoryDeps } from "./memory-run.js"
import { formatResults, type MemoryRow } from "./memory-format.js"
import { classify } from "./memory-provenance.js"
import { PROMOTE_MARK_KEY } from "./memory-sql.js"

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
  private nextRowId = 1

  prepare(sql: string): MemoryStatement {
    return {
      run: (...args: unknown[]) => {
        this.runs.push({ sql, args })
        return { lastInsertRowid: this.nextRowId++ }
      },
      all: () => {
        throw new Error("unexpected .all on prepared statement")
      },
      get: (...args: unknown[]) => {
        this.queries.push({ sql, args })
        return this.getRow
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
        return this.allRows
      },
      get: (...args: unknown[]) => {
        this.queries.push({ sql, args })
        return this.getRow
      },
    }
  }
}

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
      ["remember", "a quiet station", "--tags", "a,b", "--source", "observe", "--dims", '{"curiosity":3}'],
      deps,
    )
    expect(code).toBe(0)
    expect(embed).toHaveBeenCalledWith("a quiet station")
    // Insert bind order: ts, source, tags(joined), text, provenance, dims(json).
    expect(db.runs[0].args).toEqual([
      "2026-07-22T00:00:00.000Z",
      "observe",
      "a,b",
      "a quiet station",
      classify("observe"), // "grounded" — objective, from the write path
      '{"curiosity":3}',
    ])
    // Vector insert: id, JSON-stringified embedding.
    expect(db.runs[1].args).toEqual([1, JSON.stringify(VEC)])
    expect(out).toHaveBeenCalledWith("1")
  })

  it("defaults source to 'conscious' (→ asserted) and dims/tags to null when absent", async () => {
    const db = new FakeDb()
    const { deps } = makeDeps(db)
    await runMemory(["remember", "unsourced note"], deps)
    expect(db.runs[0].args).toEqual([
      "2026-07-22T00:00:00.000Z",
      "conscious",
      null,
      "unsourced note",
      classify("conscious"), // "asserted"
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
    // Each row: (ts, "promotion", "promotion", text, episodic, null) then vec insert.
    expect(db.runs[0].args).toEqual([
      "2026-07-22T00:00:00.000Z",
      "promotion",
      "promotion",
      "first entry",
      classify("promotion"), // "episodic"
      null,
    ])
    expect(out).toHaveBeenCalledWith("2")
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
