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
 * Repair a *truncated* JSON object into a parseable one, or return null.
 *
 * A small local model with a hard token cap (e.g. the forebrain orient tier
 * at maxTokens) can be cut off mid-token, leaving an object whose strings and
 * braces never close — `JSON.parse` then rejects the whole thing and the caller
 * loses an otherwise-good assessment. This performs a CONSERVATIVE repair: it
 * walks the candidate tracking container nesting, locates the end of the last
 * fully-completed element in the innermost open container, DROPS everything
 * after it (the partial trailing field/value), and appends the closers needed
 * to balance the still-open containers. It never guesses the content of the
 * dropped field — a truncated `"b":"par` or `"b":45` (which could really be
 * `456`) is discarded whole, not completed.
 *
 * Returns null when there is nothing to salvage: no leading `{`, or the object
 * is already balanced. A balanced-but-invalid object (e.g. a trailing comma) is
 * a different failure this deliberately does not touch.
 */
export function salvageTruncatedJson(text: string): string | null {
  const start = text.indexOf("{")
  if (start === -1) return null

  type Frame = { type: "obj" | "arr"; safeEnd: number; sawColon: boolean }
  const stack: Frame[] = []
  let inString = false
  let escaped = false
  let inScalar = false
  let balanced = false

  // Mark the current innermost container's "last completed element" boundary.
  const completeTop = (endExclusive: number): void => {
    const top = stack[stack.length - 1]
    if (!top) return
    top.safeEnd = endExclusive
    top.sawColon = false
  }

  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') {
        inString = false
        const top = stack[stack.length - 1]
        // A closed string is a completed value only inside an array, or inside
        // an object once its `:` has been seen. An object key (no colon yet)
        // completes nothing — its value is still to come.
        if (top && (top.type === "arr" || top.sawColon)) completeTop(i + 1)
      }
      continue
    }
    if (inScalar) {
      // A number / true / false / null runs until a structural delimiter.
      if (ch === "," || ch === "}" || ch === "]" || /\s/.test(ch)) {
        completeTop(i)
        inScalar = false
        // fall through to handle the delimiter char itself
      } else {
        continue
      }
    }
    if (ch === '"') {
      inString = true
    } else if (ch === "{") {
      stack.push({ type: "obj", safeEnd: i + 1, sawColon: false })
    } else if (ch === "[") {
      stack.push({ type: "arr", safeEnd: i + 1, sawColon: false })
    } else if (ch === "}" || ch === "]") {
      stack.pop()
      completeTop(i + 1)
      if (stack.length === 0) {
        // Root closed → the object was balanced, not truncated.
        balanced = true
        break
      }
    } else if (ch === ":") {
      const top = stack[stack.length - 1]
      if (top && top.type === "obj") top.sawColon = true
    } else if (ch !== "," && !/\s/.test(ch)) {
      inScalar = true
    }
  }

  if (balanced || stack.length === 0) return null

  const top = stack[stack.length - 1]
  const closers = stack
    .map((f) => (f.type === "obj" ? "}" : "]"))
    .reverse()
    .join("")
  return text.slice(start, top.safeEnd) + closers
}

/** A parse that also reports whether truncation salvage was needed. */
export type SalvageResult<T> = { ok: true; value: T; salvaged: boolean } | { ok: false }

/**
 * Parse JSON from model output, first cleanly, then falling back to a
 * conservative truncation salvage. Never throws.
 *
 *  - Clean parse succeeds → `{ ok: true, value, salvaged: false }`.
 *  - Clean parse fails but the output is a recoverable truncated object →
 *    `{ ok: true, value, salvaged: true }` (see `salvageTruncatedJson`).
 *  - Neither works (genuine garbage, or a balanced-but-invalid object) →
 *    `{ ok: false }`, so callers keep their existing parse-miss behavior.
 */
export function parseJsonSalvaging<T>(text: string): SalvageResult<T> {
  const clean = tryParseJson<T>(text)
  if (clean.ok) return { ok: true, value: clean.value, salvaged: false }
  const repaired = salvageTruncatedJson(text)
  if (repaired === null) return { ok: false }
  try {
    return { ok: true, value: JSON.parse(repaired) as T, salvaged: true }
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
