/** Normalized event type consumed by the event pipeline, runtime-agnostic. */
export type InternalEvent =
  | { type: "system"; model?: string }
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolUseId: string; text: string }
  | { type: "rate_limit"; status: string }
  | { type: "error"; message: string }
  | { type: "passthrough"; rawType: string }

type RawEvent = Record<string, unknown>

/** Normalize a Claude Code stream-json event into InternalEvents. */
export function normalizeClaude(raw: RawEvent): InternalEvent[] {
  const type = raw.type as string | undefined

  if (type === "system") {
    return [{ type: "system", model: raw.model as string | undefined }]
  }

  if (type === "rate_limit_event") {
    const info = raw.rate_limit_info as RawEvent | undefined
    return [{ type: "rate_limit", status: String(info?.status ?? "unknown") }]
  }

  if (type === "assistant") {
    const message = raw.message as RawEvent | undefined
    const content = message?.content as RawEvent[] | undefined
    if (!content) return []

    return content.map((block): InternalEvent => {
      if (block.type === "thinking") {
        return { type: "thinking", text: block.thinking as string }
      }
      if (block.type === "text") {
        return { type: "text", text: block.text as string }
      }
      if (block.type === "tool_use") {
        return {
          type: "tool_use",
          id: block.id as string,
          name: block.name as string,
          input: (block.input as Record<string, unknown>) ?? {},
        }
      }
      return { type: "passthrough", rawType: String(block.type ?? "unknown") }
    })
  }

  if (type === "user") {
    const message = raw.message as RawEvent | undefined
    const content = message?.content as RawEvent[] | undefined
    if (!content) return []

    return content
      .filter((block) => block.type === "tool_result")
      .map((block): InternalEvent => ({
        type: "tool_result",
        toolUseId: block.tool_use_id as string,
        text: (block.content as string) ?? "",
      }))
  }

  return [{ type: "passthrough", rawType: type ?? "unknown" }]
}

/** Normalize an OpenCode JSON stream event into InternalEvents. */
export function normalizeOpenCode(raw: RawEvent): InternalEvent[] {
  const type = raw.type as string | undefined
  const part = raw.part as RawEvent | undefined

  if (type === "text") {
    return [{ type: "text", text: (part?.text as string) ?? "" }]
  }

  if (type === "reasoning") {
    return [{ type: "thinking", text: (part?.text as string) ?? "" }]
  }

  if (type === "tool_use") {
    const state = part?.state as RawEvent | undefined
    return [{
      type: "tool_use",
      id: (part?.id as string) ?? "",
      name: (part?.tool as string) ?? "",
      input: (state?.input as Record<string, unknown>) ?? {},
    }]
  }

  if (type === "error") {
    const error = raw.error as RawEvent | undefined
    return [{ type: "error", message: (error?.message as string) ?? "unknown error" }]
  }

  if (type === "step_start") {
    return [{ type: "system", model: part?.model as string | undefined }]
  }

  if (type === "step_finish") {
    return []
  }

  return [{ type: "passthrough", rawType: type ?? "unknown" }]
}

/**
 * Normalize a line from the SDK runner (Phase 2). The runner wraps each SDK
 * message as `{ v:1, type:"event", event:<SDKMessage> }` and emits a terminal
 * `{ v:1, type:"result", status, output }`. We unwrap the envelope and map the
 * SDK assistant content the same way `normalizeClaude` maps stream-json
 * assistant blocks. The result line yields nothing — the turn's output comes
 * from accumulated text events (the transport already does this).
 */
export function normalizeSdk(raw: RawEvent): InternalEvent[] {
  if (raw.type === "result") return []
  if (raw.type !== "event") return []

  const event = raw.event as RawEvent | undefined
  if (!event) return []
  const eventType = event.type as string | undefined

  if (eventType === "system") {
    return [{ type: "system", model: event.model as string | undefined }]
  }
  if (eventType === "rate_limit_event") {
    const info = event.rate_limit_info as RawEvent | undefined
    return [{ type: "rate_limit", status: String(info?.status ?? "unknown") }]
  }
  if (eventType === "result") {
    return []
  }
  if (eventType === "assistant") {
    const message = event.message as RawEvent | undefined
    const content = message?.content as RawEvent[] | undefined
    if (!content) return []
    return content.map((block): InternalEvent => {
      if (block.type === "thinking") return { type: "thinking", text: block.thinking as string }
      if (block.type === "text") return { type: "text", text: block.text as string }
      if (block.type === "tool_use") {
        return {
          type: "tool_use",
          id: block.id as string,
          name: block.name as string,
          input: (block.input as Record<string, unknown>) ?? {},
        }
      }
      return { type: "passthrough", rawType: String(block.type ?? "unknown") }
    })
  }
  return [{ type: "passthrough", rawType: String(eventType ?? "unknown") }]
}
