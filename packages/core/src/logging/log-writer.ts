import { Context, Effect, Layer } from "effect"
import { FileSystem } from "@effect/platform"
import * as path from "node:path"
import type { CharacterConfig } from "../services/CharacterFs.js"
import { ProjectRoot } from "../services/ProjectRoot.js"
import type { UnifiedEvent } from "./events.js"
import { eventBase } from "./events.js"
import { renderEvent } from "./console-renderer.js"

export class LogWriterError {
  readonly _tag = "LogWriterError"
  constructor(readonly message: string, readonly cause?: unknown) {}
  toString() { return this.message }
}

export class CharacterLog extends Context.Tag("CharacterLog")<
  CharacterLog,
  {
    readonly emit: (char: CharacterConfig, event: UnifiedEvent) => Effect.Effect<void, LogWriterError>
  }
>() {}

export const CharacterLogLive = Layer.effect(
  CharacterLog,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const projectRoot = yield* ProjectRoot

    return CharacterLog.of({
      emit: (char, event) =>
        Effect.gen(function* () {
          // 1. Render to console
          const lines = renderEvent(event)
          for (const line of lines) {
            console.log(line)
          }

          // 2. Append to events.jsonl
          const logDir = path.resolve(projectRoot, "players", char.name, "logs")
          yield* fs.makeDirectory(logDir, { recursive: true }).pipe(
            Effect.catchAll(() => Effect.void),
          )
          const filePath = path.join(logDir, "events.jsonl")
          const jsonLine = JSON.stringify(event) + "\n"
          yield* fs.writeFileString(filePath, jsonLine, { flag: "a" }).pipe(
            Effect.mapError((e) => new LogWriterError("Failed to write to events.jsonl", e)),
          )
        }),
    })
  }),
)

/**
 * Convenience: build a system event and emit it.
 * Drop-in replacement for the old logToConsole — same 3-arg signature.
 * The `source` arg maps to both `system` and `subsystem` for backward compat.
 */
export const logToConsole = (
  character: string,
  source: string,
  message: string,
) =>
  Effect.gen(function* () {
    const log = yield* CharacterLog
    yield* log.emit(
      { name: character, dir: "" } as CharacterConfig,
      { ...eventBase(character, source, source), kind: "system", message },
    )
  })
