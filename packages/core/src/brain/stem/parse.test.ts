import { describe, it, expect } from "vitest"
import { extractJson, parseOr, tryParseJson, salvageTruncatedJson, parseJsonSalvaging } from "./parse.js"

describe("extractJson — tolerant extraction", () => {
  it("returns bare JSON unchanged (parseable)", () => {
    const out = extractJson('{"a":1,"b":2}')
    expect(JSON.parse(out)).toEqual({ a: 1, b: 2 })
  })

  it("unwraps a ```json fenced block", () => {
    const out = extractJson('```json\n{"a":1}\n```')
    expect(JSON.parse(out)).toEqual({ a: 1 })
  })

  it("unwraps an unlabeled ``` fenced block", () => {
    const out = extractJson('```\n{"a":1}\n```')
    expect(JSON.parse(out)).toEqual({ a: 1 })
  })

  it("extracts a balanced object after leading prose", () => {
    const out = extractJson('Here is the situation:\n{"headline":"x","metrics":{}}')
    expect(JSON.parse(out)).toEqual({ headline: "x", metrics: {} })
  })

  it("extracts a balanced object before trailing prose", () => {
    const out = extractJson('{"headline":"x"}\nHope that helps!')
    expect(JSON.parse(out)).toEqual({ headline: "x" })
  })

  it("extracts a balanced object with prose on both sides", () => {
    const out = extractJson('Sure thing.\n{"a":1}\nLet me know if you need more.')
    expect(JSON.parse(out)).toEqual({ a: 1 })
  })

  it("handles nested objects (scans to the outermost matching brace)", () => {
    const out = extractJson('prose {"a":{"b":{"c":1}},"d":2} trailing')
    expect(JSON.parse(out)).toEqual({ a: { b: { c: 1 } }, d: 2 })
  })

  it("does not split early on a '}' inside a string value", () => {
    const out = extractJson('note {"text":"a closing brace } here","n":3} end')
    expect(JSON.parse(out)).toEqual({ text: "a closing brace } here", n: 3 })
  })

  it("does not split early on an escaped quote followed by '}'", () => {
    const out = extractJson('{"text":"he said \\"hi}\\" loudly","n":1}')
    expect(JSON.parse(out)).toEqual({ text: 'he said "hi}" loudly', n: 1 })
  })

  it("returns the trimmed whole string when no object is present", () => {
    expect(extractJson("  no json here  ")).toBe("no json here")
  })
})

describe("tryParseJson", () => {
  it("returns ok:true with the parsed value for bare JSON in prose", () => {
    const r = tryParseJson<{ a: number }>('blah {"a":1} blah')
    expect(r).toEqual({ ok: true, value: { a: 1 } })
  })

  it("returns ok:false for genuinely unparseable input", () => {
    expect(tryParseJson("the model rambled")).toEqual({ ok: false })
  })

  it("returns ok:false when the first balanced object is invalid JSON (trailing comma)", () => {
    // Balanced braces are found, but JSON.parse rejects the trailing comma.
    expect(tryParseJson('{"a":1,}')).toEqual({ ok: false })
  })
})

describe("parseOr", () => {
  it("parses bare JSON wrapped in prose", () => {
    expect(parseOr('prefix {"a":1} suffix', { a: 0 })).toEqual({ a: 1 })
  })

  it("returns fallback on garbage", () => {
    expect(parseOr("not json", { ok: false })).toEqual({ ok: false })
  })

  it("returns fallback when the balanced object is invalid JSON (does not throw)", () => {
    expect(parseOr('{"a":1,}', { ok: false })).toEqual({ ok: false })
  })

  // ── merge-over-fallback (shape safety) ─────────────────────────
  // The tolerant extractor can now recover an object the old brittle parser
  // would have thrown on. That recovered object may be MISSING required
  // fields. Merging the parsed value over the fallback guarantees every
  // fallback-defined field is present, so consumers never see `undefined`.
  it("fills missing fields from the fallback (parsed fields win where present)", () => {
    // Parsed object has `a` but not `b`; fallback supplies `b`.
    expect(parseOr('{"a":1}', { a: 0, b: 99 })).toEqual({ a: 1, b: 99 })
  })

  it("leaves a fully-valid parsed object unchanged (all fields present)", () => {
    expect(parseOr('{"a":1,"b":2}', { a: 0, b: 0 })).toEqual({ a: 1, b: 2 })
  })

  it("parsed value overrides fallback for every field it defines", () => {
    expect(parseOr('{"a":7,"b":8}', { a: 0, b: 0, c: "fallback" })).toEqual({
      a: 7,
      b: 8,
      c: "fallback",
    })
  })

  // ── plain-object guard (non-object parse is a parse miss) ──────────
  // JSON.parse can yield an array / string / number. Spreading those into an
  // object literal is wrong: a bare string spreads char-by-char into index
  // keys ({"0":"d",...}), an array spreads into numeric keys. Only a non-null,
  // non-array object may merge; anything else is treated as a parse miss and
  // returns the clean fallback.
  it("returns the clean fallback for a bare JSON string (no index-key pollution)", () => {
    // extractJson finds no balanced object, so it parses the trimmed string.
    expect(parseOr('"docked"', { decision: "continue" })).toEqual({ decision: "continue" })
  })

  it("returns the clean fallback for a JSON number", () => {
    expect(parseOr("42", { decision: "continue" })).toEqual({ decision: "continue" })
  })

  it("returns the clean fallback for a JSON array", () => {
    expect(parseOr("[1,2,3]", { decision: "continue" })).toEqual({ decision: "continue" })
  })

  it("returns the clean fallback for JSON null", () => {
    expect(parseOr("null", { decision: "continue" })).toEqual({ decision: "continue" })
  })

  it("still merges a valid object over the fallback", () => {
    expect(parseOr('{"decision":"plan"}', { decision: "continue", reasoning: "fb" })).toEqual({
      decision: "plan",
      reasoning: "fb",
    })
  })
})

describe("salvageTruncatedJson — conservative truncation repair", () => {
  it("returns null for a balanced object (nothing to salvage)", () => {
    expect(salvageTruncatedJson('{"a":1,"b":2}')).toBe(null)
  })

  it("returns null when there is no object", () => {
    expect(salvageTruncatedJson("the model rambled with no json")).toBe(null)
  })

  it("returns null for a balanced-but-invalid object (does not touch trailing commas)", () => {
    // Braces balance, so it is not a truncation — a different failure this leaves alone.
    expect(salvageTruncatedJson('{"a":1,}')).toBe(null)
  })

  it("drops a trailing field cut off mid-value-string, keeping the completed fields", () => {
    const repaired = salvageTruncatedJson('{"a":1,"b":"this got cut of')
    expect(repaired).not.toBe(null)
    expect(JSON.parse(repaired as string)).toEqual({ a: 1 })
  })

  it("drops a trailing field cut off mid-key, keeping the completed fields", () => {
    const repaired = salvageTruncatedJson('{"a":1,"bcd')
    expect(repaired).not.toBe(null)
    expect(JSON.parse(repaired as string)).toEqual({ a: 1 })
  })

  it("preserves completed nested-array elements, dropping the incomplete one", () => {
    // Two complete section objects, then a third cut off mid-body — the third's
    // completed fields (id, heading) survive; only the partial `body` is dropped.
    const raw =
      '{"headline":"h","sections":[{"id":"s1","heading":"A","body":"x"},' +
      '{"id":"s2","heading":"B","body":"y"},{"id":"s3","heading":"C","body":"partial text tha'
    const repaired = salvageTruncatedJson(raw)
    expect(repaired).not.toBe(null)
    expect(JSON.parse(repaired as string)).toEqual({
      headline: "h",
      sections: [
        { id: "s1", heading: "A", body: "x" },
        { id: "s2", heading: "B", body: "y" },
        { id: "s3", heading: "C" },
      ],
    })
  })

  it("drops a trailing number that may itself be truncated", () => {
    // 45 could really be 456 — guessing is forbidden, so the whole `b` field goes.
    const repaired = salvageTruncatedJson('{"a":1,"b":45')
    expect(JSON.parse(repaired as string)).toEqual({ a: 1 })
  })

  it("does not split early on a brace inside a truncated string", () => {
    const repaired = salvageTruncatedJson('{"a":"has a } brace","b":"cut of')
    expect(JSON.parse(repaired as string)).toEqual({ a: "has a } brace" })
  })
})

describe("parseJsonSalvaging — clean-first, salvage-on-failure", () => {
  it("parses clean JSON and marks it not salvaged", () => {
    expect(parseJsonSalvaging<{ a: number }>('{"a":1}')).toEqual({ ok: true, value: { a: 1 }, salvaged: false })
  })

  it("parses clean JSON wrapped in prose without marking salvaged", () => {
    expect(parseJsonSalvaging<{ a: number }>('here: {"a":1} done')).toEqual({
      ok: true,
      value: { a: 1 },
      salvaged: false,
    })
  })

  it("salvages a truncated-mid-string object and marks it salvaged", () => {
    const r = parseJsonSalvaging<{ a: number; b?: string }>('{"a":1,"b":"was cut of')
    expect(r).toEqual({ ok: true, value: { a: 1 }, salvaged: true })
  })

  it("salvages a truncated-mid-key object and marks it salvaged", () => {
    const r = parseJsonSalvaging<{ a: number }>('{"a":1,"bc')
    expect(r).toEqual({ ok: true, value: { a: 1 }, salvaged: true })
  })

  it("falls back to ok:false on genuine garbage", () => {
    expect(parseJsonSalvaging("the model rambled")).toEqual({ ok: false })
  })

  it("falls back to ok:false on a balanced-but-invalid object (trailing comma)", () => {
    expect(parseJsonSalvaging('{"a":1,}')).toEqual({ ok: false })
  })
})
