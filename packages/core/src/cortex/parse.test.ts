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
})
