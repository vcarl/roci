import { describe, it, expect } from "vitest"
import {
  MEMORY_USAGE,
  parseTags,
  encodeRememberArgs,
  encodeSearchArgs,
  encodeMarkSetArgs,
  parseRememberArgs,
  parseSearchArgs,
  parseRecentArgs,
  parseCommand,
  type RememberEntry,
} from "./command-codec.js"

// ─── parseTags (folded in from the old memory-args) ──────────────────────────
describe("parseTags", () => {
  it("splits, trims, and drops empty tags", () => {
    expect(parseTags(" a , ,b ,")).toEqual(["a", "b"])
  })
})

// ─── Parser coverage (migrated from memory-args.test) ────────────────────────
describe("parseRememberArgs", () => {
  it("parses text and tags", () => {
    expect(parseRememberArgs(["remember", "a quiet station bar", "--tags", "place,calm"])).toEqual({
      verb: "remember",
      text: "a quiet station bar",
      tags: ["place", "calm"],
      source: "conscious",
      dims: null,
    })
  })
  it("works without tags", () => {
    expect(parseRememberArgs(["remember", "hello"])).toEqual({
      verb: "remember",
      text: "hello",
      tags: [],
      source: "conscious",
      dims: null,
    })
  })
  it("trims and drops empty tags", () => {
    expect(parseRememberArgs(["remember", "x", "--tags", " a , ,b ,"]).valueOf()).toMatchObject({
      tags: ["a", "b"],
    })
  })
  it("errors when text is missing", () => {
    expect("error" in parseRememberArgs(["remember"])).toBe(true)
  })
  it("parses an internal --source", () => {
    expect(parseRememberArgs(["remember", "x", "--source", "promotion", "--tags", "a"])).toEqual({
      verb: "remember",
      text: "x",
      tags: ["a"],
      source: "promotion",
      dims: null,
    })
  })
  it("defaults source to 'conscious' when --source is absent", () => {
    const r = parseRememberArgs(["remember", "x"])
    expect("error" in r ? null : r.source).toBe("conscious")
  })
  it("captures a valid --dims JSON string verbatim", () => {
    const r = parseRememberArgs(["remember", "x", "--dims", '{"curiosity":3}'])
    expect("error" in r ? null : r.dims).toBe('{"curiosity":3}')
  })
  it("HARD-errors on a present-but-invalid --dims (loud, not stored)", () => {
    const r = parseRememberArgs(["remember", "x", "--dims", "{not json"])
    expect("error" in r).toBe(true)
    if ("error" in r) expect(r.error).toContain("--dims must be valid JSON")
  })
})

describe("parseSearchArgs", () => {
  it("parses query, k and tags", () => {
    expect(parseSearchArgs(["search", "where did I dock", "-k", "3", "--tags", "place"])).toEqual({
      verb: "search",
      query: "where did I dock",
      k: 3,
      tags: ["place"],
    })
  })
  it("defaults k to 5 when -k absent", () => {
    expect(parseSearchArgs(["search", "q"])).toEqual({ verb: "search", query: "q", k: 5, tags: [] })
  })
  it("errors on a non-numeric -k", () => {
    expect("error" in parseSearchArgs(["search", "q", "-k", "lots"])).toBe(true)
  })
  it("errors when query is missing", () => {
    expect("error" in parseSearchArgs(["search"])).toBe(true)
  })
})

describe("parseRecentArgs", () => {
  it("parses -n", () => {
    expect(parseRecentArgs(["recent", "-n", "10"])).toEqual({ verb: "recent", n: 10 })
  })
  it("defaults n to 10 when -n absent", () => {
    expect(parseRecentArgs(["recent"])).toEqual({ verb: "recent", n: 10 })
  })
  it("errors on a non-numeric -n", () => {
    expect("error" in parseRecentArgs(["recent", "-n", "x"])).toBe(true)
  })
})

describe("parseCommand — dispatch", () => {
  it("routes mark-get / mark-set / promote", () => {
    expect(parseCommand(["mark-get"])).toEqual({ verb: "mark-get" })
    expect(parseCommand(["mark-set", '{"len":7}'])).toEqual({ verb: "mark-set", value: '{"len":7}' })
    expect(parseCommand(["mark-set"])).toEqual({ verb: "mark-set", value: "" })
    expect(parseCommand(["promote"])).toEqual({ verb: "promote" })
  })
  it("errors and surfaces usage on an unknown verb", () => {
    const r = parseCommand(["frobnicate"])
    expect("error" in r).toBe(true)
    if ("error" in r) expect(r.error).toContain(MEMORY_USAGE)
  })
  it("errors on empty argv", () => {
    expect("error" in parseCommand([])).toBe(true)
  })
})

// ─── Encoder shape: flag order + omission (byte-compat with legacy) ───────────
describe("encoders — frozen flag order + omission", () => {
  it("remember: text [--tags] --source [--dims], source always, tags/dims only when non-empty", () => {
    expect(
      encodeRememberArgs({ text: "hi", source: "observe", tags: ["a", "b"], dims: { curiosity: 3 } }),
    ).toEqual(["remember", "hi", "--tags", "a,b", "--source", "observe", "--dims", '{"curiosity":3}'])
    // empty tags → no --tags; absent dims → no --dims; --source always present.
    expect(encodeRememberArgs({ text: "hi", source: "conscious", tags: [] })).toEqual([
      "remember",
      "hi",
      "--source",
      "conscious",
    ])
    // empty dims object → omitted (→ NULL → neutral salience).
    expect(encodeRememberArgs({ text: "hi", source: "conscious", tags: [], dims: {} })).toEqual([
      "remember",
      "hi",
      "--source",
      "conscious",
    ])
  })
  it("search: query -k <k> [--tags], k always emitted (defaulted)", () => {
    expect(encodeSearchArgs({ query: "q" })).toEqual(["search", "q", "-k", "5"])
    expect(encodeSearchArgs({ query: "q", k: 3, tags: ["place"] })).toEqual([
      "search",
      "q",
      "-k",
      "3",
      "--tags",
      "place",
    ])
  })
})

// ─── Round-trip identity: parse(encode(e)) for adversarial entries ───────────
describe("round-trip identity — parse(encode(entry))", () => {
  const cases: Array<{ name: string; entry: RememberEntry }> = [
    { name: "single quotes in text", entry: { text: "it's a station", source: "observe", tags: [] } },
    { name: "double quotes + spaces", entry: { text: 'a "quiet" bar', source: "observe", tags: ["x"] } },
    { name: "unicode", entry: { text: "café ☕ 東京", source: "conscious", tags: ["城市"] } },
    { name: "newline in text", entry: { text: "line1\nline2", source: "orient", tags: [] } },
    { name: "with dims", entry: { text: "salient", source: "observe", tags: ["a"], dims: { curiosity: 4, fear: 1 } } },
    { name: "empty dims (→ omitted → neutral)", entry: { text: "trivial", source: "observe", tags: [], dims: {} } },
    { name: "absent dims", entry: { text: "no sig", source: "observe", tags: [] } },
    { name: "empty tags", entry: { text: "untagged", source: "observe", tags: [] } },
  ]
  for (const { name, entry } of cases) {
    it(name, () => {
      const parsed = parseRememberArgs(encodeRememberArgs(entry))
      expect("error" in parsed).toBe(false)
      if ("error" in parsed) return
      expect(parsed.text).toBe(entry.text)
      expect(parsed.tags).toEqual([...entry.tags])
      expect(parsed.source).toBe(entry.source)
      // empty/absent dims both round-trip to null (neutral); non-empty to the same object.
      const hasDims = entry.dims && Object.keys(entry.dims).length > 0
      if (hasDims) {
        expect(JSON.parse(parsed.dims as string)).toEqual(entry.dims)
      } else {
        expect(parsed.dims).toBeNull()
      }
    })
  }

  it("search round-trips query/k/tags", () => {
    const r = parseSearchArgs(encodeSearchArgs({ query: "where's the 'dock'?", k: 7, tags: ["a", "b"] }))
    expect(r).toEqual({ verb: "search", query: "where's the 'dock'?", k: 7, tags: ["a", "b"] })
  })
  it("mark-set round-trips the opaque value", () => {
    const r = parseCommand(encodeMarkSetArgs('{"len":42,"hash":"abc"}'))
    expect(r).toEqual({ verb: "mark-set", value: '{"len":42,"hash":"abc"}' })
  })
})
