import type { UnifiedEvent } from "./events.js"
import { effectiveLevel } from "./levels.js"

const RESET = "\x1b[0m"
const DIM = "\x1b[2m"
const BOLD = "\x1b[1m"

const PLAYER_COLORS: string[] = [
  "\x1b[36m",  // cyan
  "\x1b[33m",  // yellow
  "\x1b[35m",  // magenta
  "\x1b[32m",  // green
  "\x1b[34m",  // blue
  "\x1b[91m",  // bright red
]

const colorCache = new Map<string, string>()
let nextColorIdx = 0

export function colorFor(character: string): string {
  let c = colorCache.get(character)
  if (!c) {
    c = PLAYER_COLORS[nextColorIdx % PLAYER_COLORS.length]
    nextColorIdx++
    colorCache.set(character, c)
  }
  return c
}

export function tag(character: string, subsystem: string): string {
  const c = colorFor(character)
  return `${c}[${character}:${subsystem}]${RESET}`
}

function charName(character: string): string {
  const c = colorFor(character)
  return `${c}${BOLD}${character}${RESET}`
}

const SUPPRESS_RESULT_TOOLS = new Set(["Bash", "Read", "Glob", "Grep", "Write", "Edit"])
const toolUseRegistry = new Map<string, string>()
const MAX_HEAD = 5
const MAX_TAIL = 3
const CONSOLE_LINE_LIMIT = 800

/** Shorten one line for console display only; full text remains in events.jsonl. */
function truncateLine(line: string): string {
  if (line.length <= CONSOLE_LINE_LIMIT) return line
  return `${line.slice(0, CONSOLE_LINE_LIMIT)} … (${line.length - CONSOLE_LINE_LIMIT} more chars — full in events.jsonl)`
}

function levelMarker(event: UnifiedEvent): string {
  const lvl = effectiveLevel(event)
  if (lvl === "error") return "✖ "
  if (lvl === "warn") return "⚠ "
  return ""
}

function renderBehavior(b: import("./behavior.js").Behavior): string {
  switch (b.type) {
    case "session_start":
      return `session_start ${b.domain} (${b.character}) sha=${b.gitSha} tick=${b.tickIntervalMs}ms`
    case "session_end":
      return `session_end ${b.reason}${b.signal ? ` (${b.signal})` : ""}`
    case "provision":
      return `provision ${b.component} ${b.status}${b.detail ? ` — ${b.detail}` : ""}`
    case "phase":
      return `phase ${b.phase} ${b.transition}`
    case "reflection":
      return `reflection ${b.stage} ${b.status}${b.counts ? ` ${Object.entries(b.counts).map(([k, v]) => `${k}=${v}`).join(" ")}` : ""}`
    case "tier_call":
      return `tier_call ${b.tier} ${b.latencyMs}ms ${b.outcome}`
    case "appraisal":
      return `appraisal ${b.disposition}${b.weight !== undefined ? ` w=${b.weight}` : ""}${b.escalated ? " (escalated)" : ""}`
    case "orient":
      return `orient ${b.headline}`
    case "decision":
      return `decision ${b.disposition}`
    case "step":
      return `step ${b.phase}${b.turn !== undefined ? ` turn=${b.turn}` : ""}${b.task ? `: ${b.task}` : ""}`
    case "action":
      return `action ${b.domain}/${b.name}`
    case "note":
      return `note ${b.label}`
  }
}

export function renderEvent(event: UnifiedEvent): string[] {
  const t = tag(event.character, event.subsystem)

  switch (event.kind) {
    case "system":
      return event.message.split("\n").map(line => `${t} ${levelMarker(event)}${truncateLine(line)}`)

    case "text": {
      const lines = event.text.split("\n").filter(l => l.trim().length > 0)
      const prefix = `${charName(event.character)}:`
      return lines.map(line => `${prefix} ${truncateLine(line.trim())}`)
    }

    case "thinking": {
      const lines = event.text.split("\n").filter(l => l.trim().length > 0)
      const prefix = tag(event.character, "thinking")
      return lines.map(line => `${prefix} ${DIM}${line.trim()}${RESET}`)
    }

    case "tool_use": {
      toolUseRegistry.set(event.id, event.tool)
      const input = event.input as Record<string, unknown> | undefined
      const desc = (input?.description as string) ?? (input?.command as string) ?? ""
      const summary = desc.length > 120 ? desc.slice(0, 120) + "..." : desc
      return [`${t} ${event.tool}: ${summary}`]
    }

    case "tool_result": {
      const toolName = toolUseRegistry.get(event.toolUseId)
      if (toolName && SUPPRESS_RESULT_TOOLS.has(toolName)) return []
      const lines = event.text.split("\n").filter(l => l.trim().length > 0)
      if (lines.length === 0) return []
      const c = colorFor(event.character)
      const prefix = `${c}  >${RESET}`
      if (lines.length <= MAX_HEAD + MAX_TAIL) {
        return lines.map(line => `${prefix} ${line}`)
      }
      return [
        ...lines.slice(0, MAX_HEAD).map(line => `${prefix} ${line}`),
        `${prefix} ${DIM}... (${lines.length - MAX_HEAD - MAX_TAIL} lines omitted)${RESET}`,
        ...lines.slice(-MAX_TAIL).map(line => `${prefix} ${line}`),
      ]
    }

    case "subagent_start": {
      const c = colorFor(event.character)
      return [`${c}>> subagent start${RESET} — ${event.description}`]
    }

    case "subagent_stop":
      return [`${colorFor(event.character)}<< subagent stop${RESET}`]

    case "exchange":
      return [`${t} ${levelMarker(event)}⟳ ${event.step} prompt=${event.prompt.length}c resp=${event.response.length}c`]

    case "behavior":
      return [`${t} ${levelMarker(event)}${truncateLine(renderBehavior(event.behavior))}`]

    case "error":
      return [`${t} ${levelMarker(event)}${truncateLine(`error: ${event.message}`)}`]
  }
}

/** Format an unknown error into a readable string. */
export function formatError(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === "object" && e !== null && "message" in e) return String((e as Record<string, unknown>).message)
  return String(e)
}
