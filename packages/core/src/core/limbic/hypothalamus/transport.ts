import { Effect, Stream, Chunk, Fiber, Ref } from "effect"
import { Command, CommandExecutor } from "@effect/platform"
import type { CharacterConfig } from "../../../services/CharacterFs.js"
import type { TurnResult } from "./types.js"
import type { InternalEvent } from "../../../logging/stream-normalizer.js"
import { ClaudeError } from "../../../services/Claude.js"
import { toUnifiedEvents, eventBase } from "../../../logging/events.js"
import { CharacterLog, logToConsole } from "../../../logging/log-writer.js"

/** Parse a stream-json line, returning the parsed object or null. */
export function parseStreamJson(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
}

export function isAuthError(text: string): boolean {
  return /401|[Uu]nauthorized|[Aa]uthentication.*(error|fail)|[Ii]nvalid bearer token/i.test(text)
}

export interface TransportInput {
  /** Fully-built command to execute (e.g. `docker exec ...`), stdin already attached. */
  command: Command.Command
  /** Normalizer for this payload's stdout format. */
  normalize: (raw: Record<string, unknown>) => InternalEvent[]
  /** Subsystem tag for unified events (currently always "claude" — see Phase 1 constraints). */
  runtimeTag: string
  char: CharacterConfig
  role: "brain" | "body"
  timeoutMs: number
  /** Optional: extract a value from each raw stdout line; the first non-null is kept. */
  captureFromRaw?: (raw: Record<string, unknown>) => string | null
}

/**
 * Reusable execution transport. Starts a command, streams + normalizes +
 * accumulates its stdout, races process-exit vs timeout, interrupts on timeout,
 * and surfaces auth errors. Payload-agnostic: the same mechanism runs `claude -p`,
 * `opencode`, or (Phase 2) the SDK runner. The OAuth token is baked into `command`
 * by the caller, so this has no OAuthToken dependency.
 */
export const runTransport = (input: TransportInput): Effect.Effect<
  TurnResult,
  ClaudeError,
  CommandExecutor.CommandExecutor | CharacterLog
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const executor = yield* CommandExecutor.CommandExecutor
      const start = Date.now()
      const textAccumulator = yield* Ref.make<string[]>([])
      const capturedSessionId = yield* Ref.make<string | null>(null)
      const log = yield* CharacterLog

      const process = yield* executor.start(input.command)

      // Fork stderr drain.
      const stderrFiber = yield* process.stderr.pipe(
        Stream.decodeText(),
        Stream.runCollect,
        Effect.map(Chunk.join("")),
      ).pipe(Effect.fork)

      // Process stdout: split into lines, normalize each, accumulate text blocks.
      const streamFiber = yield* process.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line.trim().length > 0),
        Stream.mapEffect((line) =>
          Effect.gen(function* () {
            const raw = parseStreamJson(line)
            if (raw) {
              if (input.captureFromRaw) {
                const already = yield* Ref.get(capturedSessionId)
                if (already === null) {
                  const v = input.captureFromRaw(raw)
                  if (v) yield* Ref.set(capturedSessionId, v)
                }
              }
              const internal = input.normalize(raw)
              const system = input.role === "brain" ? "brain" : input.role
              const unified = toUnifiedEvents(internal, input.char.name, system, input.runtimeTag)
              for (const event of unified) {
                yield* log.emit(input.char, event)
                if (event.kind === "text") {
                  yield* Ref.update(textAccumulator, (arr) => [...arr, event.text])
                }
              }
            } else if (line.trim()) {
              yield* log.emit(input.char, {
                ...eventBase(input.char.name, input.role, input.runtimeTag),
                kind: "system",
                message: line,
              })
            }
          }),
        ),
        Stream.runDrain,
      ).pipe(Effect.fork)

      // Wait for the process to actually exit (not just stdout to drain).
      const exitFiber = yield* process.exitCode.pipe(Effect.fork)

      const timeoutEffect = Effect.sleep(input.timeoutMs).pipe(
        Effect.map(() => ({ timedOut: true as const })),
      )
      const completionEffect = Fiber.join(exitFiber).pipe(
        Effect.map((exitCode) => ({ timedOut: false as const, exitCode: Number(exitCode) })),
      )

      const raceResult = yield* Effect.race(completionEffect, timeoutEffect)

      let timedOut: boolean
      if (raceResult.timedOut) {
        timedOut = true
        yield* Fiber.interrupt(exitFiber).pipe(Effect.catchAll(() => Effect.void))
        yield* Fiber.interrupt(streamFiber).pipe(Effect.catchAll(() => Effect.void))
        yield* Fiber.interrupt(stderrFiber).pipe(Effect.catchAll(() => Effect.void))
        yield* logToConsole(input.char.name, input.role, "TIMED OUT — interrupting")
      } else {
        timedOut = false
        const exitCode = "exitCode" in raceResult ? (raceResult as { exitCode: number }).exitCode : -1
        const elapsed = Math.round((Date.now() - start) / 1000)
        yield* logToConsole(input.char.name, input.role, `Process exited (code=${exitCode}) after ${elapsed}s`)
        yield* Fiber.join(streamFiber).pipe(Effect.catchAll(() => Effect.void))
        const stderr = yield* Fiber.join(stderrFiber).pipe(Effect.catchAll(() => Effect.succeed("")))
        if (stderr && stderr.trim()) {
          yield* logToConsole(input.char.name, input.role, `stderr: ${stderr.trim().slice(0, 500)}`)
        }
        if (exitCode !== 0 && isAuthError(stderr)) {
          yield* logToConsole(input.char.name, input.role, "Auth error — token is invalid. Run 'claude setup-token' and update .oauth-token")
          return yield* Effect.fail(new ClaudeError("OAuth token rejected by Claude. Run 'claude setup-token' and update .oauth-token"))
        }
      }

      const textParts = yield* Ref.get(textAccumulator)
      const output = textParts.join("\n")
      const durationMs = Date.now() - start
      const sessionId = yield* Ref.get(capturedSessionId)
      return { output, timedOut, durationMs, sessionId: sessionId ?? undefined }
    }),
  ).pipe(
    Effect.mapError((e) =>
      e instanceof ClaudeError ? e : new ClaudeError("Process runner failed", e),
    ),
  )
