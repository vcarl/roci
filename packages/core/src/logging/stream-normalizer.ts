/** Normalized event type consumed by the event pipeline, runtime-agnostic. */
export type InternalEvent =
  | { type: "system"; model?: string }
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown>; status?: string; durationMs?: number; exitCode?: number | string }
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

/** True for a non-null object (defensive narrowing before member access). */
function isObj(v: unknown): v is RawEvent {
  return typeof v === "object" && v !== null
}

/**
 * Extract a tool exit indicator from an OpenCode tool `state`, defensively.
 *
 * Honesty note: real OpenCode tool states do NOT expose bash exit codes — the
 * only terminal signal observed on the wire is `state.status` ("completed" |
 * "error") plus `state.output`. This still probes the plausible carriers so a
 * future/richer state that DOES surface a code is captured, and otherwise names
 * the failure class on error:
 *   - a numeric `state.metadata.exit` / `state.exit` → the bash exit code
 *   - on error, a named error (`state.error.name` or a string `state.error`)
 *   - otherwise undefined (the renderer shows a bare "FAILED")
 * Never throws on any state shape.
 */
function extractExitCode(state: RawEvent | undefined, status: string | undefined): number | string | undefined {
  if (state === undefined) return undefined
  const meta = isObj(state.metadata) ? state.metadata : undefined
  if (meta && typeof meta.exit === "number") return meta.exit
  if (typeof state.exit === "number") return state.exit
  if (status === "error") {
    const err = state.error
    if (typeof err === "string" && err.trim().length > 0) return err.trim().slice(0, 60)
    if (isObj(err) && typeof err.name === "string" && err.name.length > 0) return err.name
  }
  return undefined
}

/**
 * Normalize an OpenCode JSON stream event into InternalEvents.
 *
 * Hardened to "gracefully handle all log output from OpenCode": every field
 * access is defensive (an absent/wrong-typed field degrades, never throws), and
 * every event type maps to either a typed event or an explicit
 * passthrough/ignore with a `console.debug` — nothing is silently dropped.
 */
export function normalizeOpenCode(raw: RawEvent): InternalEvent[] {
  // A non-object line (bare number/string/array survived JSON.parse) has no
  // `type`; treat it as an unknown passthrough rather than throwing on access.
  const type = isObj(raw) ? (typeof raw.type === "string" ? raw.type : undefined) : undefined
  const part = isObj(raw) && isObj(raw.part) ? raw.part : undefined

  if (type === "text") {
    return [{ type: "text", text: typeof part?.text === "string" ? part.text : "" }]
  }

  if (type === "reasoning") {
    return [{ type: "thinking", text: typeof part?.text === "string" ? part.text : "" }]
  }

  if (type === "tool_use") {
    const state = isObj(part?.state) ? part.state : undefined
    const time = isObj(state?.time) ? state.time : undefined
    const start = typeof time?.start === "number" ? time.start : undefined
    const end = typeof time?.end === "number" ? time.end : undefined
    const status = typeof state?.status === "string" ? state.status : undefined
    const id = typeof part?.id === "string" ? part.id : ""
    const exitCode = extractExitCode(state, status)
    const events: InternalEvent[] = [{
      type: "tool_use",
      id,
      name: typeof part?.tool === "string" ? part.tool : "",
      input: isObj(state?.input) ? (state.input as Record<string, unknown>) : {},
      ...(status !== undefined ? { status } : {}),
      ...(start !== undefined && end !== undefined ? { durationMs: end - start } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
    }]
    // A terminal tool state carries the tool's OUTPUT in `state.output` — the
    // actual game/CLI result. OpenCode surfaces it only on the completed/error
    // event, so emit a matching tool_result InternalEvent so the body's tool
    // outputs land in the log stream (they were previously dropped). Truncation
    // to a bounded size happens downstream in toUnifiedEvents.
    if ((status === "completed" || status === "error") && state?.output != null) {
      events.push({ type: "tool_result", toolUseId: id, text: String(state.output) })
    }
    return events
  }

  if (type === "error") {
    const error = isObj(raw.error) ? raw.error : undefined
    return [{ type: "error", message: typeof error?.message === "string" ? error.message : "unknown error" }]
  }

  if (type === "step_start") {
    return [{ type: "system", model: typeof part?.model === "string" ? part.model : undefined }]
  }

  if (type === "step_finish") {
    // Explicit ignore: step boundaries carry no InternalEvent payload.
    return []
  }

  // Any other type (including a missing/non-string `type`) is surfaced as a
  // passthrough AND debug-logged — never silently dropped.
  console.debug(`[normalizeOpenCode] passthrough for unhandled event type: ${type ?? "unknown"}`)
  return [{ type: "passthrough", rawType: type ?? "unknown" }]
}
