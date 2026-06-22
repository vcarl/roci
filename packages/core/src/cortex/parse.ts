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

/** Parse JSON from model output, returning `fallback` if extraction/parse fails. */
export function parseOr<T>(text: string, fallback: T): T {
  const r = tryParseJson<T>(text)
  return r.ok ? r.value : fallback
}
