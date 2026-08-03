import { describe, it, expect } from "vitest"
import { classify, SOURCE_PROVENANCE, PROVENANCE_DEFAULT, MIGRATION_COLUMNS } from "./memory-provenance.js"

describe("classify", () => {
  it("maps each known source to its binding provenance tier", () => {
    expect(classify("observe")).toBe("grounded")
    expect(classify("promotion")).toBe("episodic")
    expect(classify("orient")).toBe("inferred")
    expect(classify("decide")).toBe("inferred")
    expect(classify("evaluate")).toBe("inferred")
    expect(classify("conscious")).toBe("asserted")
  })
  it("falls back to asserted for an unknown source", () => {
    expect(classify("mystery")).toBe("asserted")
    expect(classify("")).toBe(PROVENANCE_DEFAULT)
  })
  it("SOURCE_PROVENANCE has an entry for every cortex write source", () => {
    for (const s of ["observe", "orient", "evaluate", "decide", "promotion", "conscious"]) {
      expect(SOURCE_PROVENANCE[s]).toBeDefined()
    }
  })
})

describe("MIGRATION_COLUMNS", () => {
  it("adds provenance with the legacy backfill default", () => {
    const prov = MIGRATION_COLUMNS.find((c) => c.name === "provenance")
    expect(prov).toBeDefined()
    expect(prov!.ddl).toContain("ADD COLUMN provenance")
    expect(prov!.ddl).toContain("DEFAULT 'episodic'")
  })
})

describe("MIGRATION_COLUMNS — dims", () => {
  it("adds dims as a nullable column with no default (legacy rows → NULL)", () => {
    const dims = MIGRATION_COLUMNS.find((c) => c.name === "dims")
    expect(dims).toBeDefined()
    expect(dims!.ddl).toContain("ADD COLUMN dims TEXT")
    expect(dims!.ddl).not.toContain("NOT NULL")
    expect(dims!.ddl).not.toContain("DEFAULT")
  })
})

describe("phase 2 migration columns", () => {
  it("adds the three salience columns, idempotently and after dims", () => {
    const names = MIGRATION_COLUMNS.map((c) => c.name)
    expect(names).toEqual([
      "provenance",
      "dims",
      "dims_a",
      "dims_c",
      "dims_stage",
      "lineage_state",
      "lineage_prior_id",
      "lineage_distance",
      "lineage_similarity",
    ])
  })

  it("dims_a and dims_c are nullable with no default — an unscored old row has no A or C", () => {
    const byName = new Map(MIGRATION_COLUMNS.map((c) => [c.name, c.ddl]))
    expect(byName.get("dims_a")).toBe("ALTER TABLE memories ADD COLUMN dims_a TEXT")
    expect(byName.get("dims_c")).toBe("ALTER TABLE memories ADD COLUMN dims_c TEXT")
  })

  it("dims_stage backfills legacy rows to 'legacy', NOT 'base' — the sweep must not adopt them", () => {
    const byName = new Map(MIGRATION_COLUMNS.map((c) => [c.name, c.ddl]))
    expect(byName.get("dims_stage")).toBe(
      "ALTER TABLE memories ADD COLUMN dims_stage TEXT NOT NULL DEFAULT 'legacy'",
    )
  })

  it("every migration statement is an ADD COLUMN — the mechanism expresses nothing else", () => {
    // main.ts guards each of these with a PRAGMA table_info presence check and
    // nothing more: there is no version number, no applied-table, no ordering
    // beyond this array. A statement that is not an idempotent ADD COLUMN would
    // re-run on every single CLI invocation.
    for (const c of MIGRATION_COLUMNS) {
      expect(c.ddl.startsWith(`ALTER TABLE memories ADD COLUMN ${c.name} `)).toBe(true)
    }
  })
})

describe("lineage migration columns", () => {
  const byName = new Map(MIGRATION_COLUMNS.map((c) => [c.name, c.ddl]))

  it("backfills pre-existing rows to 'legacy' — LINEAGE UNKNOWN, never 'nothing restated'", () => {
    // This is the whole contract for the 825-row corpus that already exists.
    // A default of 'first' (or a nullable state read as "no prior found") would
    // present an entire historical corpus of heavy restatement as novel.
    expect(byName.get("lineage_state")).toBe(
      "ALTER TABLE memories ADD COLUMN lineage_state TEXT NOT NULL DEFAULT 'legacy'",
    )
    expect(byName.get("lineage_state")).not.toContain("'first'")
  })

  it("the three value columns are nullable with NO default — an old row has no measured prior", () => {
    expect(byName.get("lineage_prior_id")).toBe(
      "ALTER TABLE memories ADD COLUMN lineage_prior_id INTEGER",
    )
    expect(byName.get("lineage_distance")).toBe(
      "ALTER TABLE memories ADD COLUMN lineage_distance REAL",
    )
    expect(byName.get("lineage_similarity")).toBe(
      "ALTER TABLE memories ADD COLUMN lineage_similarity REAL",
    )
    // A DEFAULT here would fabricate a similarity for rows nothing ever measured.
    for (const n of ["lineage_prior_id", "lineage_distance", "lineage_similarity"]) {
      expect(byName.get(n)).not.toContain("DEFAULT")
    }
  })
})
