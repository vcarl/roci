import { Effect, Ref, Stream } from "effect"
import type { CharacterConfig } from "../services/CharacterFs.js"
import { CharacterLog, type LogEntry } from "./log-writer.js"
import { logCharThought, logThinking, logCharResult, logStreamEvent } from "./console-renderer.js"

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
  textAccumulator?: Ref.Ref<string[]>,
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
        if (block.type === "thinking") {
          // Extended thinking — show on console
          const text = (block.thinking as string) ?? ""
          if (text.trim()) {
            yield* logThinking(char.name, text)
          }
        } else if (block.type === "text") {
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

          // Character's voice — shown on console
          yield* logCharThought(char.name, block.text as string)
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

          // All tool calls go to actions log
          yield* log.action(char, entry)

          // sm chat/forum commands also go to words log
          if (toolName === "Bash" && SOCIAL_COMMAND_PATTERN.test(command)) {
            yield* log.word(char, entry)
          }

          // Show tool invocations on console with a compact summary
          if (toolName === "Bash") {
            const preview = command.split("\n")[0].slice(0, 120)
            yield* logStreamEvent(char.name, source, `$ ${preview}`)
          } else if (toolName === "Agent") {
            const desc = (input?.description as string) ?? (input?.prompt as string)?.slice(0, 80) ?? ""
            yield* logStreamEvent(char.name, source, `[Agent] ${desc}`)
          } else if (toolName === "Read" || toolName === "Glob" || toolName === "Grep") {
            const target = (input?.file_path as string) ?? (input?.pattern as string) ?? ""
            yield* logStreamEvent(char.name, source, `[${toolName}] ${target}`)
          } else if (toolName === "Edit" || toolName === "Write") {
            const target = (input?.file_path as string) ?? ""
            yield* logStreamEvent(char.name, source, `[${toolName}] ${target}`)
          } else {
            yield* logStreamEvent(char.name, source, `[${toolName}]`)
          }
        }
        // Other content block types suppressed from stdout
      }
    } else if (type === "result") {
      // Subagent result — only show errors on console
      const isError = event.is_error as boolean | undefined
      const result = event.result as string | undefined
      if (isError && result) {
        yield* logStreamEvent(char.name, "error", `Subagent error: ${result}`)
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

      // Show tool result output (truncated: first 10 + last 5 lines)
      const message = event.message as Record<string, unknown> | undefined
      const resultContent = message?.content as Array<Record<string, unknown>> | undefined
      if (resultContent) {
        for (const block of resultContent) {
          if (block.type === "tool_result") {
            const text = (block.content as string) ?? ""
            if (text.trim()) {
              yield* logCharResult(char.name, text)
            }
          }
        }
      }
    }
    // system, unknown event types suppressed from stdout (still captured in stream.jsonl)
  })

/**
 * Process a stream of stream-json lines, routing each event to the
 * appropriate JSONL log files.  Every raw line is also appended to stream.jsonl.
 */
export const demuxStream = (
  char: CharacterConfig,
  lines: Stream.Stream<string, unknown>,
  source: LogEntry["source"] = "subagent",
  textAccumulator?: Ref.Ref<string[]>,
) =>
  lines.pipe(
    Stream.filter((line) => line.trim().length > 0),
    Stream.mapEffect((line) =>
      Effect.gen(function* () {
        const log = yield* CharacterLog

        // Raw capture — every line goes to stream.jsonl verbatim
        yield* log.raw(char, line)

        // Try to parse as JSON
        const event = parseStreamJson(line)
        if (event) {
          yield* demuxEvent(char, event, source, textAccumulator)
        } else {
          // Non-JSON line — log as [raw] so it's visible
          yield* logStreamEvent(char.name, "raw", line)
        }
      }),
    ),
    Stream.runDrain,
  )
