/**
 * Find the first balanced top-level `{...}` object in `text`, or null.
 *
 * Scans from the first `{` to its matching `}`, tracking nesting depth and
 * ignoring braces that appear inside double-quoted strings (including escaped
 * quotes). This tolerates leading and/or trailing prose around bare JSON, the
 * common 9B forebrain output shape.
 */
function firstBalancedObject(text: string): string | null {
  const start = text.indexOf("{")
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === "\\") {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === "{") {
      depth++
    } else if (ch === "}") {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/**
 * Extract a JSON candidate string from model output. Pure string function.
 *
 * Resolution order:
 *  1. A ```json or ``` fenced block (existing behavior).
 *  2. The first balanced top-level `{...}` object, tolerating surrounding prose.
 *  3. The trimmed whole string (existing behavior).
 *
 * The returned string is a *candidate* — it may still fail `JSON.parse`
 * (e.g. a trailing comma). Callers should parse in a try/catch.
 */
export function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) return fenced[1].trim()
  const balanced = firstBalancedObject(text)
  if (balanced !== null) return balanced
  return text.trim()
}

/**
 * True only for a non-null, non-array object — the one shape the spread merge
 * in `parseOr` (and the equivalent merge in `runForebrain`) is safe over.
 * `JSON.parse` can legitimately yield an array / string / number / null; those
 * must NOT be spread into an object literal (a bare string spreads char-by-char
 * into index keys), so callers treat a non-plain-object parse as a parse miss.
 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** A successful or failed parse, without throwing. */
export type ParseResult<T> = { ok: true; value: T } | { ok: false }

/**
 * Attempt to extract + parse JSON from model output. Never throws.
 * Returns `{ ok: true, value }` on success, `{ ok: false }` otherwise —
 * including when a balanced object is found but is not valid JSON.
 */
export function tryParseJson<T>(text: string): ParseResult<T> {
  try {
    return { ok: true, value: JSON.parse(extractJson(text)) as T }
  } catch {
    return { ok: false }
  }
}

/**
 * Parse JSON from model output, returning `fallback` if extraction/parse fails.
 *
 * On a successful parse of a plain object the result is `{ ...fallback, ...parsed }`
 * — parsed fields win where present, the fallback fills anything the model
 * omitted. The tolerant extractor can now recover a parseable-but-incomplete
 * object that the old brittle parser would have rejected; merging over the
 * fallback guarantees every fallback-defined field is present so consumers
 * never read `undefined`.
 *
 * The invariant the merge relies on: `parsed.value` is a non-null, non-array
 * object. `JSON.parse` can also yield an array / string / number / null — those
 * are NOT mergeable (spreading a string produces index keys), so a non-plain-
 * object parse is treated as a parse miss and the clean fallback is returned.
 */
export function parseOr<T>(text: string, fallback: T): T {
  const r = tryParseJson<T>(text)
  if (!r.ok || !isPlainObject(r.value)) return fallback
  return { ...fallback, ...r.value }
}
