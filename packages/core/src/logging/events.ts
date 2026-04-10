import type { InternalEvent } from "./stream-normalizer.js"

export interface EventBase {
  timestamp: string
  character: string
  system: string
  subsystem: string
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
        return { ...base, kind: "system", message: e.model ? `init model=${e.model}` : "init" }
      case "thinking":
        return { ...base, kind: "thinking", text: e.text }
      case "text":
        return { ...base, kind: "text", text: e.text }
      case "tool_use":
        return { ...base, kind: "tool_use", tool: e.name, id: e.id, input: e.input }
      case "tool_result":
        return { ...base, kind: "tool_result", toolUseId: e.toolUseId, text: e.text }
      case "rate_limit":
        return { ...base, kind: "error", message: `rate_limit: ${e.status}` }
      case "error":
        return { ...base, kind: "error", message: e.message }
      case "passthrough":
        return { ...base, kind: "system", message: e.rawType }
    }
  })
}
