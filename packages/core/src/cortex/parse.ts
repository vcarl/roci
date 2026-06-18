/** Extract JSON from model output that may be wrapped in a markdown code fence. */
export function extractJson(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  return match ? match[1].trim() : text.trim()
}

/** Parse JSON from model output, returning `fallback` if extraction/parse fails. */
export function parseOr<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(extractJson(text)) as T
  } catch {
    return fallback
  }
}
