import { Context, Effect, Layer } from "effect"
import { FileSystem } from "@effect/platform"
import * as path from "node:path"
import type { CharacterConfig } from "../services/CharacterFs.js"

export interface LogEntry {
  timestamp: string
  source: "subagent" | "brain" | "monitor" | "dream" | "dinner" | "orchestrator"
  character: string
  [key: string]: unknown
}

export class LogWriterError {
  readonly _tag = "LogWriterError"
  constructor(readonly message: string, readonly cause?: unknown) {}
}

export class CharacterLog extends Context.Tag("CharacterLog")<
  CharacterLog,
  {
    readonly thought: (char: CharacterConfig, entry: LogEntry) => Effect.Effect<void, LogWriterError>
    readonly word: (char: CharacterConfig, entry: LogEntry) => Effect.Effect<void, LogWriterError>
    readonly action: (char: CharacterConfig, entry: LogEntry) => Effect.Effect<void, LogWriterError>
  }
>() {}

export const makeCharacterLogLive = (projectRoot: string) =>
  Layer.effect(
    CharacterLog,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem

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

      return CharacterLog.of({
        thought: (char, entry) => appendLog(char, "thoughts.jsonl", entry),
        word: (char, entry) => appendLog(char, "words.jsonl", entry),
        action: (char, entry) => appendLog(char, "actions.jsonl", entry),
      })
    }),
  )
