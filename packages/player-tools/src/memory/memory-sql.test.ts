import { describe, it, expect } from "vitest"
import {
  EMBED_DIM,
  PROMOTE_MARK_KEY,
  buildSchemaSql,
  buildInsertSql,
  buildVecInsertSql,
  buildKnnSql,
  buildRecentSql,
  buildPendingSql,
  buildAdjudicateSql,
  buildMetaGetSql,
  buildMetaSetSql,
  STAGE_BASE,
  STAGE_ADJUDICATED,
  STAGE_LEGACY,
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
  it("inserts provenance in the fixed column order", () => {
    // Phase 2 extended the 6-column form to 9 (dims_a, dims_c, dims_stage); see
    // "phase 2 salience columns" below for the exact pinned string.
    const sql = buildInsertSql()
    expect(sql).toContain("(ts, source, tags, text, provenance, dims, dims_a, dims_c, dims_stage)")
    expect(sql).toContain("VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
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
    expect(sql).toContain("dims")
    expect(sql).toContain("VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
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

describe("buildSchemaSql — dims column", () => {
  it("declares dims as a nullable TEXT column (no default)", () => {
    const sql = buildSchemaSql()
    expect(sql).toContain("dims TEXT")
    // nullable: the dims line carries neither NOT NULL nor DEFAULT
    const dimsLine = sql.split("\n").find((l) => l.includes("dims TEXT"))
    expect(dimsLine).toBeDefined()
    expect(dimsLine!).not.toContain("NOT NULL")
    expect(dimsLine!).not.toContain("DEFAULT")
  })
})

describe("buildInsertSql — dims column", () => {
  it("inserts nine columns in a fixed order with nine binds (Phase 2: + dims_a, dims_c, dims_stage)", () => {
    const sql = buildInsertSql()
    expect(sql).toContain("(ts, source, tags, text, provenance, dims, dims_a, dims_c, dims_stage)")
    expect(sql).toContain("VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
  })
})

describe("buildKnnSql — dims column", () => {
  it("selects dims alongside the ranked row", () => {
    expect(buildKnnSql(5)).toContain("m.dims AS dims")
  })
})

describe("phase 2 salience columns", () => {
  it("the schema carries dims_a, dims_c and a legacy-defaulted stage marker", () => {
    const sql = buildSchemaSql()
    expect(sql).toContain("dims TEXT")
    expect(sql).toContain("dims_a TEXT")
    expect(sql).toContain("dims_c TEXT")
    // 'legacy', not 'base': a pre-Phase-2 row was never through the pipeline and
    // must never cost the adjudicator a model call (design §8).
    expect(sql).toContain("dims_stage TEXT NOT NULL DEFAULT 'legacy'")
  })

  it("the insert binds all nine columns in a fixed order", () => {
    expect(buildInsertSql()).toBe(
      "INSERT INTO memories (ts, source, tags, text, provenance, dims, dims_a, dims_c, dims_stage) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
  })

  // The stage marker travels under its COLUMN name; `formatResults` owns the
  // single rename to the wire name `stage`. An `AS stage` alias here silently
  // broke that (the formatter reads `r.dims_stage`) — see the derived-key seam
  // tests in memory-format.test.ts, which fail if either side renames again.
  it("knn selects the stage marker so 'never adjudicated' is queryable from a recall", () => {
    const sql = buildKnnSql(5)
    expect(sql).toContain("m.dims AS dims")
    expect(sql).toContain("m.dims_stage AS dims_stage")
    expect(sql).not.toContain("AS stage")
  })

  it("recent selects the same field set as knn, minus the distance", () => {
    const sql = buildRecentSql(10)
    expect(sql).toContain("dims_stage")
    expect(sql).not.toContain("AS stage")
    expect(sql).toContain("LIMIT 10")
    expect(sql).not.toContain("distance")
  })

  it("pending selects only base-stage rows with both producer vectors, oldest first", () => {
    const sql = buildPendingSql(25)
    expect(sql).toContain("WHERE dims_stage = 'base'")
    expect(sql).toContain("id, text, dims_a, dims_c")
    expect(sql).toContain("ORDER BY id ASC")
    expect(sql).toContain("LIMIT 25")
    // legacy rows are NOT swept
    expect(sql).not.toContain("'legacy'")
  })

  it("pending rejects a non-integer cap rather than interpolating it", () => {
    expect(() => buildPendingSql(1.5)).toThrow(/positive integer/)
    expect(() => buildPendingSql(0)).toThrow(/positive integer/)
    expect(() => buildPendingSql(Number.NaN)).toThrow(/positive integer/)
  })

  it("adjudicate updates ONLY the derived columns, on one id", () => {
    expect(buildAdjudicateSql()).toBe(
      "UPDATE memories SET dims = ?, dims_stage = 'adjudicated' WHERE id = ?",
    )
  })

  it("exports the three stage markers at one site", () => {
    expect([STAGE_BASE, STAGE_ADJUDICATED, STAGE_LEGACY]).toEqual(["base", "adjudicated", "legacy"])
  })
})
