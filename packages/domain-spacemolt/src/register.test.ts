import { describe, it, expect } from "vitest"
import { deriveUsername, pickEmpire, sessionFileContent } from "./register.js"
import { validateSessionFile } from "./session.js"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

describe("deriveUsername", () => {
  it("lowercases, underscores separators, and strips everything else", () => {
    expect(deriveUsername("Ada Lovelace")).toBe("ada_lovelace")
    expect(deriveUsername("Jean-Luc")).toBe("jean_luc")
    expect(deriveUsername("O'Brien!")).toBe("obrien")
  })

  it("truncates to 24 characters — the server's username cap", () => {
    expect(deriveUsername("a".repeat(40))).toHaveLength(24)
  })
})

describe("pickEmpire", () => {
  it("is deterministic — the same character always lands in the same empire", () => {
    expect(pickEmpire("vcarl")).toBe(pickEmpire("vcarl"))
    expect(pickEmpire("ada")).toBe(pickEmpire("ada"))
  })

  it("only ever returns a real empire id", () => {
    const valid = new Set(["solarian", "crimson", "nebula", "voidborn", "outerrim"])
    for (const n of ["a", "bb", "ccc", "vcarl", "ada", "Jean-Luc", ""]) {
      expect(valid.has(pickEmpire(n))).toBe(true)
    }
  })
})

describe("sessionFileContent", () => {
  it("writes the version-2 MultiSessionFile shape the CLI and roci both read", () => {
    // This is the ONE thing registration does that cannot be exercised against
    // the live server (registration is a mutation), so the format is pinned
    // here instead — and pinned by feeding it to the real validator below.
    expect(JSON.parse(sessionFileContent("ada", "deadbeef"))).toEqual({
      version: 2,
      activeAccount: "ada",
      accounts: { ada: { username: "ada", password: "deadbeef" } },
    })
  })

  it("ends with a newline", () => {
    expect(sessionFileContent("ada", "x").endsWith("}\n")).toBe(true)
  })

  it("round-trips through the REAL validateSessionFile", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "roci-register-"))
    const file = path.join(dir, ".spacemolt-session.json")
    writeFileSync(file, sessionFileContent("ada", "deadbeef"))
    const check = validateSessionFile(file)
    expect(check.ok).toBe(true)
    if (check.ok) expect(check.username).toBe("ada")
  })
})
