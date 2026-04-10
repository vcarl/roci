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
    return [{
      type: "tool_use",
      id: (part?.id as string) ?? "",
      name: (part?.name as string) ?? "",
      input: (part?.input as Record<string, unknown>) ?? {},
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
