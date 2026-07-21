import type { ToolEpisode } from "../../../logging/episodes.js"

/**
 * The mechanical `## Tool Calls This Step` trace rendered into the conscious
 * evaluate prompt. Today the evaluator judges a step ONLY on the body's narrated
 * `executionReport`; the actual tool calls are architecturally excluded. This
 * renders the step's tool episodes — description, tool, truncated command, and
 * metadata (outcome, exit code, runtime, output size) — as a bounded block so
 * the evaluator can weigh what the body actually DID against what it SAID.
 */

/** Hard cap on rendered trace lines; the middle is elided past this. */
export const MAX_TRACE_LINES = 30
/** Lines kept from the head when eliding an over-cap trace. */
const HEAD_LINES = 15
/** Shown when the step recorded no tool calls. */
export const EMPTY_TRACE = "_No tool calls recorded this step._"

/** Human bytes: `210B`, `3.3KB`, `1.5MB`. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / (1024 * 1024)).toFixed(1)}MB`
}

/** Human duration: sub-second as `ms`, otherwise seconds with one decimal (`1.2s`). */
function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** `ok` / `FAILED` / `FAILED exit <code>` from status + exit code. */
function formatStatus(e: ToolEpisode): string {
  if (e.status !== "error") return "ok"
  return e.exitCode !== undefined ? `FAILED exit ${e.exitCode}` : "FAILED"
}

/**
 * One trace line. With a description it leads with the description and names the
 * tool + command in parens; without one it leads with the tool + command:
 *   `market view (bash: "spacemolt view_market --station frontier") — ok, 12ms, 3.3KB out`
 *   `bash: "spacemolt storage/view" — ok, 2ms, 210B out`
 * Runtime and output size are appended only when known.
 */
function renderLine(e: ToolEpisode): string {
  const command = e.command ?? e.argsSummary
  const desc = e.description?.trim()
  const lead = desc ? `${desc} (${e.tool}: "${command}")` : `${e.tool}: "${command}"`
  const parts = [formatStatus(e)]
  if (e.durationMs != null) parts.push(formatDuration(e.durationMs))
  if (e.outputChars != null) parts.push(`${formatBytes(e.outputChars)} out`)
  return `${lead} — ${parts.join(", ")}`
}

/**
 * Render the step's tool episodes (chronological, newest-last) as a bounded
 * trace. Empty → {@link EMPTY_TRACE}. Over {@link MAX_TRACE_LINES} → keep the
 * head and tail and elide the middle with a `… N more calls …` marker so the
 * first actions and the final outcome both survive.
 */
export function renderToolTrace(episodes: readonly ToolEpisode[]): string {
  if (episodes.length === 0) return EMPTY_TRACE
  const lines = episodes.map(renderLine)
  if (lines.length <= MAX_TRACE_LINES) return lines.join("\n")
  const tailCount = MAX_TRACE_LINES - 1 - HEAD_LINES
  const head = lines.slice(0, HEAD_LINES)
  const tail = lines.slice(lines.length - tailCount)
  const elided = lines.length - HEAD_LINES - tailCount
  return [...head, `… ${elided} more calls …`, ...tail].join("\n")
}
