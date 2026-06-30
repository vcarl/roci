import type { LogLevel, UnifiedEvent } from "./events.js"

export type { LogLevel }

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export function rank(level: LogLevel): number {
  return RANK[level]
}

/** Default level for an event when no explicit level was set. */
export function classifyLevel(event: UnifiedEvent): LogLevel {
  switch (event.kind) {
    case "error":
      return "error"
    case "thinking":
    case "exchange":
      return "debug"
    case "behavior": {
      const b = event.behavior
      if (b.type === "note") return b.severity ?? "info"
      if (b.type === "provision" && b.status === "failed") return "warn"
      if (b.type === "session_end" && b.reason === "error") return "warn"
      return "info"
    }
    case "system":
    case "text":
    case "tool_use":
    case "tool_result":
    case "subagent_start":
    case "subagent_stop":
      return "info"
  }
}

/** Resolve the effective level: an explicit override wins, else classify. */
export function effectiveLevel(event: UnifiedEvent): LogLevel {
  return event.level ?? classifyLevel(event)
}

/** True if an event at `level` should appear given the console `threshold`. */
export function passesThreshold(level: LogLevel, threshold: LogLevel): boolean {
  return rank(level) >= rank(threshold)
}

const VALID = new Set<string>(["debug", "info", "warn", "error"])

/** Parse a LOG_LEVEL env value into a console threshold; defaults to "info". */
export function resolveThreshold(raw: string | undefined): LogLevel {
  const v = raw?.trim().toLowerCase()
  return v && VALID.has(v) ? (v as LogLevel) : "info"
}
