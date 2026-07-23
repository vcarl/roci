import { Context, Effect, Layer } from "effect"
import { FileSystem } from "@effect/platform"
import * as path from "node:path"
import { makeCharacterConfig, type CharacterConfig } from "../services/CharacterFs.js"
import { logsDir } from "../services/character-paths.js"
import { ProjectRoot } from "../services/ProjectRoot.js"
import type { LogLevel, UnifiedEvent } from "./events.js"
import { eventBase } from "./events.js"
import { renderEvent } from "./console-renderer.js"
import { effectiveLevel, passesThreshold, resolveThreshold } from "./levels.js"
import type { Behavior } from "./behavior.js"
import { recordBehavior, snapshotDigest, tryMarkEnded, emptyBehaviorDigest } from "./behavior-digest.js"

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

          // 2. Append the full event (with resolved level) to events.jsonl.
          // Derive the canonical player root from projectRoot + name (log helpers
          // hand us name-only configs), then resolve the logs subtree through the
          // shared logsDir accessor — the single players/<name>/logs derivation.
          const logDir = logsDir(makeCharacterConfig(projectRoot, char.name))
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
      { name: character, root: "" } as CharacterConfig,
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
      { name: character, root: "" } as CharacterConfig,
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
      { name: character, root: "" } as CharacterConfig,
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

/**
 * Emit a structured behavior event — the source of truth for "what the bot did".
 * Folds the behavior into the per-character digest accumulator, and for the
 * terminal `session_end` snapshots that accumulator inline so the emitted event
 * is the authoritative run digest. Best-effort: a log-write failure can never
 * crash the loop or orchestrator (mirrors logExchange's resilience).
 */
export const logBehavior = (
  character: string,
  system: string,
  subsystem: string,
  behavior: Behavior,
): Effect.Effect<void, never, CharacterLog> =>
  Effect.gen(function* () {
    const base = eventBase(character, system, subsystem)
    recordBehavior(character, behavior, base.timestamp)
    const finalBehavior: Behavior =
      behavior.type === "session_end"
        ? { ...behavior, digest: snapshotDigest(character) }
        : behavior
    const log = yield* CharacterLog
    yield* log.emit(
      { name: character, root: "" } as CharacterConfig,
      { ...base, kind: "behavior", behavior: finalBehavior },
    )
  }).pipe(Effect.catchAll(() => Effect.void))

/**
 * Idempotent terminal emit. The first call per character emits a `session_end`
 * carrying the inline digest snapshot; subsequent calls (e.g. the onExit path
 * AND a signal handler racing) are no-ops via the `tryMarkEnded` guard.
 */
export const logSessionEnd = (
  character: string,
  reason: "clean" | "signal" | "error",
  signal?: string,
): Effect.Effect<void, never, CharacterLog> =>
  Effect.gen(function* () {
    if (!tryMarkEnded(character)) return
    yield* logBehavior(character, "orchestrator", "main", {
      type: "session_end",
      reason,
      ...(signal ? { signal } : {}),
      digest: emptyBehaviorDigest(),
    })
  })
