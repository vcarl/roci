import { Context, Effect, Layer } from "effect"
import { FileSystem } from "@effect/platform"
import * as path from "node:path"
import type { CharacterConfig } from "../services/CharacterFs.js"
import { ProjectRoot } from "../services/ProjectRoot.js"

export interface LogEntry {
  timestamp: string
  source: "subagent" | "brain" | "body" | "monitor" | "dream" | "dinner" | "orchestrator" | "ws"
  character: string
  [key: string]: unknown
}

export class LogWriterError {
  readonly _tag = "LogWriterError"
  constructor(readonly message: string, readonly cause?: unknown) {}
  toString() { return this.message }
}

export class CharacterLog extends Context.Tag("CharacterLog")<
  CharacterLog,
  {
    readonly thought: (char: CharacterConfig, entry: LogEntry) => Effect.Effect<void, LogWriterError>
    readonly word: (char: CharacterConfig, entry: LogEntry) => Effect.Effect<void, LogWriterError>
    readonly action: (char: CharacterConfig, entry: LogEntry) => Effect.Effect<void, LogWriterError>
    /** Append a raw line (already a string) to stream.jsonl — no JSON.stringify wrapping. */
    readonly raw: (char: CharacterConfig, line: string) => Effect.Effect<void, LogWriterError>
  }
>() {}

export const CharacterLogLive = Layer.effect(
  CharacterLog,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const projectRoot = yield* ProjectRoot

    const appendLog = (char: CharacterConfig, logFile: string, entry: LogEntry) =>
      Effect.gen(function* () {
        const logDir = path.resolve(projectRoot, "players", char.name, "logs")
        yield* fs.makeDirectory(logDir, { recursive: true }).pipe(
          Effect.catchAll(() => Effect.void),
        )
        const filePath = path.join(logDir, logFile)
        const line = JSON.stringify(entry) + "\n"
        yield* fs.writeFileString(filePath, line, { flag: "a" }).pipe(
          Effect.mapError((e) => new LogWriterError(`Failed to write to ${logFile}`, e)),
        )
      })

    const appendRaw = (char: CharacterConfig, logFile: string, line: string) =>
      Effect.gen(function* () {
        const logDir = path.resolve(projectRoot, "players", char.name, "logs")
        yield* fs.makeDirectory(logDir, { recursive: true }).pipe(
          Effect.catchAll(() => Effect.void),
        )
        const filePath = path.join(logDir, logFile)
        yield* fs.writeFileString(filePath, line + "\n", { flag: "a" }).pipe(
          Effect.mapError((e) => new LogWriterError(`Failed to write to ${logFile}`, e)),
        )
      })

    return CharacterLog.of({
      thought: (char, entry) => appendLog(char, "thoughts.jsonl", entry),
      word: (char, entry) => appendLog(char, "words.jsonl", entry),
      action: (char, entry) => appendLog(char, "actions.jsonl", entry),
      raw: (char, line) => appendRaw(char, "stream.jsonl", line),
    })
  }),
)
