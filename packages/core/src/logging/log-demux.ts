import { Effect, Ref } from "effect"
import type { CharacterConfig } from "../services/CharacterFs.js"
import { CharacterLog, type LogEntry } from "./log-writer.js"
import {
  tag,
  logCharThought,
  logThinking,
  logCharResult,
} from "./console-renderer.js"

const RESET = "\x1b[0m"
const DIM = "\x1b[2m"

/** Patterns matching sm CLI commands that are social (chat/forum). */
const SOCIAL_COMMAND_PATTERN = /^sm\s+(chat|forum)\b/

/** Parse a stream-json line into a structured event, or null if not parseable. */
function parseStreamJson(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Print a raw stream-json line to stdout with a character:source tag prefix. */
export function printRaw(character: string, source: string, line: string): void {
  console.log(`${tag(character, source)} ${line}`)
}

/** Indent string for nested sub-agent output. */
const INDENT = "  "

/** Tools whose results are suppressed from console (the tool_use line already shows the command/description). */
const SUPPRESS_RESULT_TOOLS = new Set(["Bash", "Read", "Glob", "Grep", "Write", "Edit"])

/** Track tool_use_id → tool name so we can decide how to display results. */
const toolUseRegistry = new Map<string, string>()

/** Compute indent: subagent source or nested Claude agent (parent_tool_use_id). */
function indentFor(source: string, event: Record<string, unknown>): string {
  if (source === "subagent") return INDENT
  if (event.parent_tool_use_id) return INDENT
  return ""
}

/** Print formatted console output for a stream-json event. */
function printEvent(character: string, source: string, event: Record<string, unknown>): void {
  const type = event.type as string | undefined
  const indent = indentFor(source, event)

  if (type === "system") {
    const model = (event as Record<string, unknown>).model as string | undefined
    console.log(`${indent}${tag(character, source)} ${DIM}init${model ? ` model=${model}` : ""}${RESET}`)
    return
  }

  if (type === "rate_limit_event") {
    const info = event.rate_limit_info as Record<string, unknown> | undefined
    const status = info?.status ?? "unknown"
    console.log(`${indent}${tag(character, source)} ${DIM}rate_limit: ${status}${RESET}`)
    return
  }

  if (type === "assistant") {
    const message = event.message as Record<string, unknown> | undefined
    const content = message?.content as Array<Record<string, unknown>> | undefined
    if (!content) {
      console.log(`${indent}${tag(character, source)} ${DIM}assistant (empty)${RESET}`)
      return
    }

    for (const block of content) {
      if (block.type === "thinking") {
        // Handled by logThinking Effect below — skip sync printing
      } else if (block.type === "text") {
        // Handled by logCharThought Effect below — skip sync printing
      } else if (block.type === "tool_use") {
        const toolName = block.name as string
        const input = block.input as Record<string, unknown> | undefined
        const desc = (input?.description as string) ?? (input?.command as string) ?? ""
        const summary = desc.length > 120 ? desc.slice(0, 120) + "..." : desc
        console.log(`${indent}${tag(character, source)} ${toolName}: ${summary}`)
      } else {
        console.log(`${indent}${tag(character, source)} ${DIM}${String(block.type ?? "block")}${RESET}`)
      }
    }
    return
  }

  if (type === "user") {
    // tool_result — handled by logCharResult Effect below for content display
    return
  }

  // Unknown event type — always show something
  console.log(`${indent}${tag(character, source)} ${DIM}${type ?? "unknown"}${RESET}`)
}

/** Classify and route a single stream-json event to the appropriate log streams. */
export const demuxEvent = (
  char: CharacterConfig,
  rawLine: string,
  event: Record<string, unknown>,
  source: LogEntry["source"] = "subagent",
  textAccumulator?: Ref.Ref<string[]>,
) =>
  Effect.gen(function* () {
    const log = yield* CharacterLog
    const ts = new Date().toISOString()
    const type = event.type as string | undefined

    // Formatted console output — preserves something from every event
    const indent = indentFor(source, event)
    printEvent(char.name, source, event)

    if (type === "assistant") {
      const message = event.message as Record<string, unknown> | undefined
      const content = message?.content as Array<Record<string, unknown>> | undefined
      if (!content) return

      for (const block of content) {
        if (block.type === "thinking") {
          yield* logThinking(char.name, block.thinking as string, indent)
        } else if (block.type === "text") {
          yield* logCharThought(char.name, block.text as string, indent)

          yield* log.thought(char, {
            timestamp: ts,
            source,
            character: char.name,
            type: "text",
            text: block.text,
          })

          // Accumulate text for completion report
          if (textAccumulator) {
            yield* Ref.update(textAccumulator, (arr) => [...arr, block.text as string])
          }
        } else if (block.type === "tool_use") {
          const toolName = block.name as string
          const toolUseId = block.id as string | undefined
          if (toolUseId) toolUseRegistry.set(toolUseId, toolName)
          const input = block.input as Record<string, unknown> | undefined
          const command = (input?.command as string) ?? ""

          const entry: LogEntry = {
            timestamp: ts,
            source,
            character: char.name,
            type: "tool_use",
            tool: toolName,
            input,
          }

          // All tool calls go to actions log
          yield* log.action(char, entry)

          // sm chat/forum commands also go to words log
          if (toolName === "Bash" && SOCIAL_COMMAND_PATTERN.test(command)) {
            yield* log.word(char, entry)
          }
        }
      }
    } else if (type === "user") {
      // tool_result — log to actions + show truncated output (unless suppressed)
      const msg = event.message as Record<string, unknown> | undefined
      const resultContent = msg?.content as Array<Record<string, unknown>> | undefined
      if (resultContent) {
        for (const block of resultContent) {
          const text = block.content as string | undefined
          if (!text) continue
          // Suppress output for tools where the tool_use line is sufficient
          const toolUseId = block.tool_use_id as string | undefined
          const toolName = toolUseId ? toolUseRegistry.get(toolUseId) : undefined
          if (toolName && SUPPRESS_RESULT_TOOLS.has(toolName)) continue
          yield* logCharResult(char.name, text, indent)
        }
      }

      yield* log.action(char, {
        timestamp: ts,
        source,
        character: char.name,
        type: "tool_result",
        content: event.message,
      })
    }
  })

