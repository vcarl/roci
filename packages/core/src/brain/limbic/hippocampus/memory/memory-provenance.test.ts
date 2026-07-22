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
