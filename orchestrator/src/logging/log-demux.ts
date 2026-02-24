import { Effect, Stream } from "effect"
import type { CharacterConfig } from "../services/CharacterFs.js"
import { CharacterLog, type LogEntry } from "./log-writer.js"

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

/** Classify and route a single stream-json event to the appropriate log streams. */
export const demuxEvent = (
  char: CharacterConfig,
  event: Record<string, unknown>,
  source: LogEntry["source"] = "subagent",
) =>
  Effect.gen(function* () {
    const log = yield* CharacterLog
    const ts = new Date().toISOString()
    const type = event.type as string | undefined

    if (type === "assistant") {
      const message = event.message as Record<string, unknown> | undefined
      const content = message?.content as Array<Record<string, unknown>> | undefined
      if (!content) return

      for (const block of content) {
        if (block.type === "text") {
          yield* log.thought(char, {
            timestamp: ts,
            source,
            character: char.name,
            type: "text",
            text: block.text,
          })
        } else if (block.type === "tool_use") {
          const toolName = block.name as string
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

          // All tool calls go to actions
          yield* log.action(char, entry)

          // sm chat/forum commands also go to words
          if (toolName === "Bash" && SOCIAL_COMMAND_PATTERN.test(command)) {
            yield* log.word(char, entry)
          }
        }
      }
    } else if (type === "user") {
      // tool_result — log to actions
      yield* log.action(char, {
        timestamp: ts,
        source,
        character: char.name,
        type: "tool_result",
        content: event.message,
      })
    }
  })

/**
 * Process a stream of stream-json lines, routing each event to the
 * appropriate JSONL log files.
 */
export const demuxStream = (
  char: CharacterConfig,
  lines: Stream.Stream<string, unknown>,
  source: LogEntry["source"] = "subagent",
) =>
  lines.pipe(
    Stream.filter((line) => line.trim().length > 0),
    Stream.map(parseStreamJson),
    Stream.filter((event): event is Record<string, unknown> => event !== null),
    Stream.mapEffect((event) => demuxEvent(char, event, source)),
    Stream.runDrain,
  )
