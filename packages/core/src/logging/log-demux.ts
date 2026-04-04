import { Effect, Ref } from "effect"
import type { CharacterConfig } from "../services/CharacterFs.js"
import { CharacterLog, type LogEntry } from "./log-writer.js"
import {
  tag,
  logCharThought,
  logThinking,
  logCharResult,
} from "./console-renderer.js"
import { type InternalEvent, normalizeClaude } from "./stream-normalizer.js"

const RESET = "\x1b[0m"
const DIM = "\x1b[2m"

/** Patterns matching sm CLI commands that are social (chat/forum). */
const SOCIAL_COMMAND_PATTERN = /^sm\s+(chat|forum)\b/

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

/** Compute indent: subagent source. */
function indentFor(source: string): string {
  if (source === "subagent") return INDENT
  return ""
}

/** Classify and route a list of InternalEvents to the appropriate log streams. */
export const demuxEvents = (
  char: CharacterConfig,
  events: InternalEvent[],
  source: LogEntry["source"],
  textAccumulator?: Ref.Ref<string[]>,
) =>
  Effect.gen(function* () {
    const log = yield* CharacterLog
    const ts = new Date().toISOString()
    const indent = indentFor(source)

    for (const event of events) {
      if (event.type === "system") {
        console.log(`${indent}${tag(char.name, source)} ${DIM}init${event.model ? ` model=${event.model}` : ""}${RESET}`)

      } else if (event.type === "thinking") {
        yield* logThinking(char.name, event.text, indent)

      } else if (event.type === "text") {
        yield* logCharThought(char.name, event.text, indent)

        yield* log.thought(char, {
          timestamp: ts,
          source,
          character: char.name,
          type: "text",
          text: event.text,
        })

        if (textAccumulator) {
          yield* Ref.update(textAccumulator, (arr) => [...arr, event.text])
        }

      } else if (event.type === "tool_use") {
        toolUseRegistry.set(event.id, event.name)
        const desc = (event.input?.description as string) ?? (event.input?.command as string) ?? ""
        const summary = desc.length > 120 ? desc.slice(0, 120) + "..." : desc
        console.log(`${indent}${tag(char.name, source)} ${event.name}: ${summary}`)

        const entry: LogEntry = {
          timestamp: ts,
          source,
          character: char.name,
          type: "tool_use",
          tool: event.name,
          input: event.input,
        }

        yield* log.action(char, entry)

        if (event.name === "Bash" && SOCIAL_COMMAND_PATTERN.test((event.input?.command as string) ?? "")) {
          yield* log.word(char, entry)
        }

      } else if (event.type === "tool_result") {
        const toolName = toolUseRegistry.get(event.toolUseId)
        if (!toolName || !SUPPRESS_RESULT_TOOLS.has(toolName)) {
          yield* logCharResult(char.name, event.text, indent)
        }

        yield* log.action(char, {
          timestamp: ts,
          source,
          character: char.name,
          type: "tool_result",
          content: event.text,
        })

      } else if (event.type === "rate_limit") {
        console.log(`${indent}${tag(char.name, source)} ${DIM}rate_limit: ${event.status}${RESET}`)

      } else if (event.type === "error") {
        console.log(`${indent}${tag(char.name, source)} ${DIM}error: ${event.message}${RESET}`)

      } else if (event.type === "passthrough") {
        console.log(`${indent}${tag(char.name, source)} ${DIM}${event.rawType}${RESET}`)
      }
    }
  })

/** Classify and route a single stream-json event to the appropriate log streams.
 * @deprecated Prefer demuxEvents with normalizeClaude/normalizeOpenCode. This wrapper
 * remains for backward compatibility until process-runner.ts is updated in Task 4.
 */
export const demuxEvent = (
  char: CharacterConfig,
  rawLine: string,
  event: Record<string, unknown>,
  source: LogEntry["source"] = "subagent",
  textAccumulator?: Ref.Ref<string[]>,
) =>
  Effect.gen(function* () {
    const events = normalizeClaude(event)
    yield* demuxEvents(char, events, source, textAccumulator)
  })
