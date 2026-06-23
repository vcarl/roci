import { describe, it, expect } from "vitest"
import { extractJson, parseOr, tryParseJson } from "./parse.js"

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
