import type { InternalEvent } from "./stream-normalizer.js"

export type LogLevel = "debug" | "info" | "warn" | "error"

export interface EventBase {
  timestamp: string
  character: string
  system: string
  subsystem: string
  /** Optional explicit level; when absent, classifyLevel() supplies a default. */
  level?: LogLevel
}

export type UnifiedEvent = EventBase & (
  | { kind: "system"; message: string }
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; tool: string; id: string; input: unknown }
  | { kind: "tool_result"; toolUseId: string; text: string }
  | { kind: "subagent_start"; description: string; data: unknown }
  | { kind: "subagent_stop"; data: unknown }
  | { kind: "error"; message: string }
  | { kind: "exchange"; channel: string; step: string; prompt: string; response: string; meta?: Record<string, unknown> }
)

export function eventBase(character: string, system: string, subsystem: string): EventBase {
  return { timestamp: new Date().toISOString(), character, system, subsystem }
}

export function toUnifiedEvents(
  events: InternalEvent[],
  character: string,
  system: string,
  subsystem: string,
): UnifiedEvent[] {
  const base = eventBase(character, system, subsystem)
  return events.map((e): UnifiedEvent => {
    switch (e.type) {
      case "system":
        return { ...base, kind: "system", message: e.model ? `init model=${e.model}` : "init", level: "debug" }
      case "thinking":
        return { ...base, kind: "thinking", text: e.text }
      case "text":
        return { ...base, kind: "text", text: e.text }
      case "tool_use":
        return { ...base, kind: "tool_use", tool: e.name, id: e.id, input: e.input }
      case "tool_result":
        return { ...base, kind: "tool_result", toolUseId: e.toolUseId, text: e.text }
      case "rate_limit":
        return { ...base, kind: "system", message: `rate_limit: ${e.status}`, level: "warn" }
      case "error":
        return { ...base, kind: "error", message: e.message }
      case "passthrough":
        return { ...base, kind: "system", message: e.rawType, level: "debug" }
    }
  })
}
