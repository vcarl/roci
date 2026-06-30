import { describe, it, expect } from "vitest"
import { parseMemoryArgs, MEMORY_USAGE } from "./memory-args.js"

describe("parseMemoryArgs — remember", () => {
  it("parses text and tags", () => {
    const r = parseMemoryArgs(["remember", "a quiet station bar", "--tags", "place,calm"])
    expect(r).toEqual({ verb: "remember", text: "a quiet station bar", tags: ["place", "calm"] })
  })
  it("works without tags", () => {
    expect(parseMemoryArgs(["remember", "hello"])).toEqual({ verb: "remember", text: "hello" })
  })
  it("trims and drops empty tags", () => {
    const r = parseMemoryArgs(["remember", "x", "--tags", " a , ,b ,"])
    expect(r).toEqual({ verb: "remember", text: "x", tags: ["a", "b"] })
  })
  it("errors when text is missing", () => {
    const r = parseMemoryArgs(["remember"])
    expect("error" in r).toBe(true)
  })
  it("parses an internal --source (keeps the locked grammar in sync with the CLI)", () => {
    const r = parseMemoryArgs(["remember", "x", "--source", "promotion", "--tags", "a"])
    expect(r).toEqual({ verb: "remember", text: "x", tags: ["a"], source: "promotion" })
  })
  it("omits source when --source is absent", () => {
    const r = parseMemoryArgs(["remember", "x"])
    expect("source" in r).toBe(false)
  })
})

describe("parseMemoryArgs — search", () => {
  it("parses query, k and tags", () => {
    const r = parseMemoryArgs(["search", "where did I dock", "-k", "3", "--tags", "place"])
    expect(r).toEqual({ verb: "search", query: "where did I dock", k: 3, tags: ["place"] })
  })
  it("defaults k when -k absent (no k key)", () => {
    expect(parseMemoryArgs(["search", "q"])).toEqual({ verb: "search", query: "q" })
  })
  it("errors on a non-numeric -k", () => {
    expect("error" in parseMemoryArgs(["search", "q", "-k", "lots"])).toBe(true)
  })
  it("errors when query is missing", () => {
    expect("error" in parseMemoryArgs(["search"])).toBe(true)
  })
})

describe("parseMemoryArgs — recent", () => {
  it("parses -n", () => {
    expect(parseMemoryArgs(["recent", "-n", "10"])).toEqual({ verb: "recent", n: 10 })
  })
  it("works with no -n", () => {
    expect(parseMemoryArgs(["recent"])).toEqual({ verb: "recent" })
  })
  it("errors on a non-numeric -n", () => {
    expect("error" in parseMemoryArgs(["recent", "-n", "x"])).toBe(true)
  })
})

describe("parseMemoryArgs — bad input", () => {
  it("errors and surfaces usage on an unknown verb", () => {
    const r = parseMemoryArgs(["frobnicate"])
    expect("error" in r).toBe(true)
    if ("error" in r) expect(r.error).toContain(MEMORY_USAGE)
  })
  it("errors on empty argv", () => {
    expect("error" in parseMemoryArgs([])).toBe(true)
  })
})
