import { Context, Effect, Layer } from "effect"
import { FileSystem } from "@effect/platform"
import * as path from "node:path"
import type { CharacterConfig } from "../services/CharacterFs.js"
import { ProjectRoot } from "../services/ProjectRoot.js"
import type { LogLevel, UnifiedEvent } from "./events.js"
import { eventBase } from "./events.js"
import { renderEvent } from "./console-renderer.js"
import { effectiveLevel, passesThreshold, resolveThreshold } from "./levels.js"

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
    const threshold = resolveThreshold(process.env.LOG_LEVEL)

    return CharacterLog.of({
      emit: (char, event) =>
        Effect.gen(function* () {
          const level = effectiveLevel(event)
          const leveled = { ...event, level } as UnifiedEvent

          // 1. Render to console, threshold-filtered
          if (passesThreshold(level, threshold)) {
            const lines = renderEvent(leveled)
            for (const line of lines) {
              console.log(line)
            }
          }

          // 2. Append the full event (with resolved level) to events.jsonl
          const logDir = path.resolve(projectRoot, "players", char.name, "logs")
          yield* fs.makeDirectory(logDir, { recursive: true }).pipe(
            Effect.catchAll(() => Effect.void),
          )
          const filePath = path.join(logDir, "events.jsonl")
          const jsonLine = JSON.stringify(leveled) + "\n"
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
  level?: LogLevel,
) =>
  Effect.gen(function* () {
    const log = yield* CharacterLog
    yield* log.emit(
      { name: character, dir: "" } as CharacterConfig,
      { ...eventBase(character, source, source), kind: "system", message, ...(level ? { level } : {}) },
    )
  })

/**
 * Emit a structured `kind:"error"` event. Unlike `logToConsole(..., "error")`
 * — which emits a `kind:"system"` line whose `source` arg is cosmetic and which
 * classifies to `info` — this builds a true error event (`classifyLevel` resolves
 * it to `error`, so it outranks any console threshold) for genuine failure sites.
 * `source` maps to both `system` and `subsystem`, mirroring `logToConsole`.
 */
export const logError = (
  character: string,
  source: string,
  message: string,
) =>
  Effect.gen(function* () {
    const log = yield* CharacterLog
    yield* log.emit(
      { name: character, dir: "" } as CharacterConfig,
      { ...eventBase(character, source, source), kind: "error", message },
    )
  })

/**
 * Emit a structured prompt+response exchange. Full content is stored in
 * events.jsonl; classifyLevel ranks it `debug`, so it stays out of the default
 * console view. Tag is [character:step].
 */
export const logExchange = (
  character: string,
  channel: string,
  step: string,
  prompt: string,
  response: string,
  meta?: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const log = yield* CharacterLog
    yield* log.emit(
      { name: character, dir: "" } as CharacterConfig,
      {
        ...eventBase(character, channel, step),
        kind: "exchange",
        channel,
        step,
        prompt,
        response,
        ...(meta ? { meta } : {}),
      },
    )
  })
