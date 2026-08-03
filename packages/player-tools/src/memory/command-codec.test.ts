import { describe, it, expect } from "vitest"
import {
  MEMORY_USAGE,
  parseTags,
  encodeRememberArgs,
  encodeSearchArgs,
  encodeMarkSetArgs,
  encodePendingArgs,
  encodeAdjudicateArgs,
  parseRememberArgs,
  parseSearchArgs,
  parseRecentArgs,
  parsePendingArgs,
  parseAdjudicateArgs,
  parseCommand,
  DEFAULT_PENDING_N,
  LEGACY_DIMS_FLAG,
  type RememberEntry,
  type RememberParsed,
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
  it("captures a valid --dims-c JSON string verbatim", () => {
    const r = parseRememberArgs(["remember", "x", "--dims-c", '{"curiosity":3}'])
    expect("error" in r ? null : r.dims).toBe('{"curiosity":3}')
  })
  it("HARD-errors on a present-but-invalid --dims-c (loud, not stored)", () => {
    const r = parseRememberArgs(["remember", "x", "--dims-c", "{not json"])
    expect("error" in r).toBe(true)
    if ("error" in r) expect(r.error).toContain("--dims-c must be valid JSON")
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
  it("remember: text [--tags] --source [--dims-c], source always, tags/dims only when non-empty", () => {
    expect(
      encodeRememberArgs({ text: "hi", source: "observe", tags: ["a", "b"], dims: { curiosity: 3 } }),
    ).toEqual(["remember", "hi", "--tags", "a,b", "--source", "observe", "--dims-c", '{"curiosity":3}'])
    // empty tags → no --tags; absent dims → no --dims-c; --source always present.
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

describe("remember --dims-c is the PRODUCER (C) vector", () => {
  it("emits --dims-c, with flag ORDER unchanged from phase 1", () => {
    expect(
      encodeRememberArgs({ text: "t", source: "observe", tags: ["a", "b"], dims: { safety: 0.6 } }),
    ).toEqual(["remember", "t", "--tags", "a,b", "--source", "observe", "--dims-c", '{"safety":0.6}'])
  })

  it("no longer emits the retired --dims spelling anywhere", () => {
    const argv = encodeRememberArgs({ text: "t", source: "observe", tags: [], dims: { safety: 0.6 } })
    expect(argv).not.toContain("--dims")
    expect(argv).toContain("--dims-c")
  })

  it("still OMITS the flag when the producer vector is empty or absent", () => {
    expect(encodeRememberArgs({ text: "t", source: "conscious", tags: [] })).toEqual([
      "remember", "t", "--source", "conscious",
    ])
    expect(encodeRememberArgs({ text: "t", source: "conscious", tags: [], dims: {} })).toEqual([
      "remember", "t", "--source", "conscious",
    ])
  })

  it("round-trips a SIGNED bipolar component — the sign is the point", () => {
    const argv = encodeRememberArgs({
      text: "t", source: "observe", tags: [], dims: { "burdened-exhilarated": -0.7 },
    })
    const parsed = parseRememberArgs(argv)
    expect("error" in parsed).toBe(false)
    expect(JSON.parse((parsed as RememberParsed).dims!)).toEqual({ "burdened-exhilarated": -0.7 })
  })

  it("a malformed --dims-c is STILL a hard parse error, never a silently stored corrupt vector", () => {
    const r = parseRememberArgs(["remember", "t", "--dims-c", "{not json"])
    expect("error" in r).toBe(true)
  })
})

describe("the retired --dims spelling fails LOUDLY", () => {
  // Without this, `takeFlag` simply would not consume `--dims`: the flag and its
  // JSON fall through into the positional remainder, `rest[0]` still resolves to
  // the memory text, and the row is written with NO producer vector — successfully,
  // silently. That is the version-skew failure this rename would otherwise create.
  it("rejects a remember carrying the old flag", () => {
    const r = parseRememberArgs(["remember", "t", "--source", "observe", "--dims", '{"safety":0.6}'])
    expect("error" in r).toBe(true)
  })

  it("names BOTH spellings in the error so the fix is obvious from the message", () => {
    const r = parseRememberArgs(["remember", "t", "--dims", "{}"]) as { error: string }
    expect(r.error).toContain("--dims")
    expect(r.error).toContain("--dims-c")
  })

  it("rejects it even when the value is well-formed — silence is the failure mode", () => {
    expect("error" in parseRememberArgs(["remember", "t", "--dims", "{}"])).toBe(true)
  })

  it("does NOT reject --dims-c by prefix confusion", () => {
    expect("error" in parseRememberArgs(["remember", "t", "--dims-c", "{}"])).toBe(false)
  })

  it("does not reject a remember whose TEXT merely mentions the old flag", () => {
    const r = parseRememberArgs(["remember", "I tried passing --dims and it did nothing", "--source", "conscious"])
    expect("error" in r).toBe(false)
    expect((r as RememberParsed).text).toBe("I tried passing --dims and it did nothing")
  })

  it("exports the retired spelling as a constant", () => {
    expect(LEGACY_DIMS_FLAG).toBe("--dims")
  })
})

describe("pending", () => {
  it("encodes with an explicit cap and defaults to 25", () => {
    expect(encodePendingArgs(10)).toEqual(["pending", "-n", "10"])
    expect(encodePendingArgs()).toEqual(["pending", "-n", "25"])
    expect(DEFAULT_PENDING_N).toBe(25)
  })

  it("parses the cap and applies the default when -n is absent", () => {
    expect(parsePendingArgs(["pending", "-n", "3"])).toEqual({ verb: "pending", n: 3 })
    expect(parsePendingArgs(["pending"])).toEqual({ verb: "pending", n: DEFAULT_PENDING_N })
  })

  it("rejects a non-positive-integer cap", () => {
    expect("error" in parsePendingArgs(["pending", "-n", "0"])).toBe(true)
    expect("error" in parsePendingArgs(["pending", "-n", "2.5"])).toBe(true)
    expect("error" in parsePendingArgs(["pending", "-n", "lots"])).toBe(true)
  })
})

describe("adjudicate", () => {
  it("encodes the id and the authoritative vector as JSON", () => {
    expect(encodeAdjudicateArgs(41, { safety: 0.9, "cynical-curious": -0.2 })).toEqual([
      "adjudicate", "41", '{"safety":0.9,"cynical-curious":-0.2}',
    ])
  })

  it("round-trips through the parser", () => {
    const parsed = parseAdjudicateArgs(encodeAdjudicateArgs(41, { safety: 0.9 }))
    expect(parsed).toEqual({ verb: "adjudicate", id: 41, dims: '{"safety":0.9}' })
  })

  it("rejects a non-integer id — an UPDATE must never target a guessed row", () => {
    expect("error" in parseAdjudicateArgs(["adjudicate", "abc", "{}"])).toBe(true)
    expect("error" in parseAdjudicateArgs(["adjudicate", "-1", "{}"])).toBe(true)
    expect("error" in parseAdjudicateArgs(["adjudicate", "1.5", "{}"])).toBe(true)
  })

  it("rejects malformed JSON — same loudness rule as --dims-c", () => {
    expect("error" in parseAdjudicateArgs(["adjudicate", "41", "{nope"])).toBe(true)
  })

  it("rejects a missing vector rather than defaulting it to {}", () => {
    expect("error" in parseAdjudicateArgs(["adjudicate", "41"])).toBe(true)
  })
})

describe("parseCommand dispatch", () => {
  it("routes both new verbs", () => {
    expect(parseCommand(["pending", "-n", "5"])).toEqual({ verb: "pending", n: 5 })
    expect(parseCommand(["adjudicate", "9", "{}"])).toEqual({ verb: "adjudicate", id: 9, dims: "{}" })
  })

  it("still rejects an unknown verb", () => {
    expect("error" in parseCommand(["adjudicated"])).toBe(true)
  })
})
