import { describe, it, expect } from "vitest"
import {
  EMBED_DIM,
  PROMOTE_MARK_KEY,
  buildSchemaSql,
  buildInsertSql,
  buildVecInsertSql,
  buildKnnSql,
  buildMetaGetSql,
  buildMetaSetSql,
} from "./memory-sql.js"

describe("EMBED_DIM", () => {
  it("is the proven bge-small dimension (384)", () => {
    expect(EMBED_DIM).toBe(384)
  })
})

describe("buildSchemaSql", () => {
  const sql = buildSchemaSql()
  it("creates the append-only memories table with the spec columns", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS memories")
    expect(sql).toContain("id INTEGER PRIMARY KEY")
    expect(sql).toContain("ts TEXT NOT NULL")
    expect(sql).toContain("source TEXT NOT NULL")
    expect(sql).toContain("tags TEXT")
    expect(sql).toContain("text TEXT NOT NULL")
  })
  it("creates the vec0 virtual table keyed by the same id at the embed dim", () => {
    expect(sql).toContain("CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0")
    expect(sql).toContain("id INTEGER PRIMARY KEY")
    expect(sql).toContain(`embedding FLOAT[${EMBED_DIM}]`)
  })
  it("creates the 1-row meta table that holds the bounded promotion high-water mark", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS meta")
    expect(sql).toContain("key TEXT PRIMARY KEY")
    expect(sql).toContain("value TEXT")
  })
  it("honours an explicit dimension override", () => {
    expect(buildSchemaSql(8)).toContain("embedding FLOAT[8]")
  })
})

describe("buildSchemaSql — provenance column", () => {
  it("declares provenance with the legacy-safe default", () => {
    expect(buildSchemaSql()).toContain("provenance TEXT NOT NULL DEFAULT 'episodic'")
  })
})

describe("buildInsertSql — provenance column", () => {
  it("inserts five columns in a fixed order with five binds", () => {
    const sql = buildInsertSql()
    expect(sql).toContain("(ts, source, tags, text, provenance)")
    expect(sql).toContain("VALUES (?, ?, ?, ?, ?)")
  })
})

describe("buildKnnSql — provenance column", () => {
  it("selects provenance alongside the ranked row", () => {
    expect(buildKnnSql(5)).toContain("m.provenance AS provenance")
  })
})

describe("buildInsertSql / buildVecInsertSql", () => {
  it("inserts a memories row with ts/source/tags/text/provenance placeholders", () => {
    const sql = buildInsertSql()
    expect(sql).toContain("INSERT INTO memories")
    expect(sql).toContain("ts")
    expect(sql).toContain("source")
    expect(sql).toContain("tags")
    expect(sql).toContain("text")
    expect(sql).toContain("provenance")
    expect(sql).toContain("VALUES (?, ?, ?, ?, ?)")
  })
  it("inserts the vector row keyed by the same id", () => {
    const sql = buildVecInsertSql()
    expect(sql).toContain("INSERT INTO memories_vec")
    expect(sql).toContain("id")
    expect(sql).toContain("embedding")
    expect(sql).toContain("VALUES (?, ?)")
  })
})

describe("meta high-water mark SQL", () => {
  it("reads/writes the promote mark by its key with bound params", () => {
    expect(PROMOTE_MARK_KEY).toBe("promote_mark")
    expect(buildMetaGetSql()).toContain("SELECT value FROM meta WHERE key = ?")
    const set = buildMetaSetSql()
    expect(set).toContain("INSERT OR REPLACE INTO meta")
    expect(set).toContain("VALUES (?, ?)")
  })
})

describe("buildKnnSql", () => {
  it("bakes k as a literal (sqlite-vec requires k = <constant>) and binds the query vector", () => {
    const sql = buildKnnSql(5)
    expect(sql).toContain("embedding MATCH ?")
    expect(sql).toContain("k = 5")
    expect(sql).toMatch(/ORDER BY\s+v?\.?distance/)
  })
  it("joins the vec table back to memories to return the record fields", () => {
    const sql = buildKnnSql(5)
    expect(sql).toContain("JOIN memories")
    expect(sql).toContain("text")
    expect(sql).toContain("distance")
  })
  it("over-fetches when a tag filter is supplied (post-filtered in JS)", () => {
    const plain = buildKnnSql(5)
    const filtered = buildKnnSql(5, ["combat"])
    // The filtered query asks the index for more than k rows so JS tag-filtering
    // can still return ~k after dropping non-matching rows.
    expect(plain).toContain("k = 5")
    expect(filtered).not.toContain("k = 5")
    const m = filtered.match(/k = (\d+)/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBeGreaterThan(5)
  })
})
