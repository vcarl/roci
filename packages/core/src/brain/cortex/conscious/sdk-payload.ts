/** The host→runner `end` control NDJSON line (no trailing newline). */
export function endLine(): string {
  return JSON.stringify({ v: 1, type: "end" })
}
