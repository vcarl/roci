import { Effect, Stream, Chunk, Fiber, Ref } from "effect"
import { Command, CommandExecutor } from "@effect/platform"
import type { TurnConfig, TurnResult } from "./types.js"
import { ClaudeError } from "../../../services/Claude.js"
import { CharacterLog } from "../../../logging/log-writer.js"
import { demuxEvent, printRaw } from "../../../logging/log-demux.js"
import { logToConsole } from "../../../logging/console-renderer.js"

/**
 * Shell-safe literal using $'...' ANSI-C quoting.
 */
function shellEscape(s: string): string {
  let escaped = ""
  for (const ch of s) {
    const code = ch.charCodeAt(0)
    if (ch === "\\") escaped += "\\\\"
    else if (ch === "'") escaped += "\\'"
    else if (ch === "\n") escaped += "\\n"
    else if (ch === "\r") escaped += "\\r"
    else if (ch === "\t") escaped += "\\t"
    else if (code < 0x20 || code === 0x7f) escaped += `\\x${code.toString(16).padStart(2, "0")}`
    else escaped += ch
  }
  return `$'${escaped}'`
}

/**
 * Parse a stream-json line, returning the parsed object or null.
 */
function parseStreamJson(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Run `claude -p` inside a container with a timeout.
 * Streams output through the log demux for real-time console visibility.
 * Collects text blocks as the final output string.
 * On timeout, interrupts and returns whatever text was accumulated.
 */
export const runTurn = (config: TurnConfig): Effect.Effect<
  TurnResult,
  ClaudeError,
  CommandExecutor.CommandExecutor | CharacterLog
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const executor = yield* CommandExecutor.CommandExecutor
      const start = Date.now()

      // Accumulate text output from assistant messages
      const textAccumulator = yield* Ref.make<string[]>([])

      // Build claude flags — use stream-json for real-time output
      // Note: run-step.sh already adds --permission-mode bypassPermissions
      const claudeArgs: string[] = [
        "--model", config.model,
        "--output-format", "stream-json",
        "--verbose",
      ]

      // Brain (opus) uses full effort; body needs normal effort for multi-step
      // workflows; only apply low effort to non-body, non-opus roles (old subagents)
      if (config.model !== "opus" && config.role !== "body") {
        claudeArgs.push("--effort", "low")
      }

      if (config.allowedTools && config.allowedTools.length > 0) {
        claudeArgs.push("--allowedTools", config.allowedTools.join(","))
      }

      if (config.disallowedTools && config.disallowedTools.length > 0) {
        claudeArgs.push("--disallowedTools", config.disallowedTools.join(","))
      }

      if (config.systemPrompt) {
        claudeArgs.push("--system-prompt", shellEscape(config.systemPrompt))
      }

      const innerCmd = `/opt/scripts/run-step.sh ${config.playerName} ${claudeArgs.join(" ")}`
      const promptStream = Stream.encodeText(Stream.make(config.prompt))

      // Build docker exec args
      const execArgs: string[] = ["exec", "-i"]
      if (config.env) {
        for (const [key, val] of Object.entries(config.env)) {
          execArgs.push("-e", `${key}=${val}`)
        }
      }
      execArgs.push(config.containerId, "bash", "-c", innerCmd)

      const cmd = Command.make("docker", ...execArgs).pipe(
        Command.stdin(promptStream),
      )

      const process = yield* executor.start(cmd)

      // Fork stderr drain
      const stderrFiber = yield* process.stderr.pipe(
        Stream.decodeText(),
        Stream.runCollect,
        Effect.map(Chunk.join("")),
      ).pipe(Effect.fork)

      // Process stdout: split into lines, demux each for console output,
      // accumulate text blocks for the final output string
      const source = config.role as "brain" | "body"
      const log = yield* CharacterLog

      const streamFiber = yield* process.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line.trim().length > 0),
        Stream.mapEffect((line) =>
          Effect.gen(function* () {
            // Raw capture to stream.jsonl
            yield* log.raw(config.char, line)

            const event = parseStreamJson(line)
            if (event) {
              yield* demuxEvent(config.char, line, event, source, textAccumulator)
            } else {
              printRaw(config.char.name, "raw", line)
            }
          }),
        ),
        Stream.runDrain,
      ).pipe(Effect.fork)

      // Wait for the process to actually exit (not just stdout to drain).
      // Stdout can close/drain mid-session (e.g. after a ToolSearch response)
      // while the claude process is still running and waiting for the next API call.
      const exitFiber = yield* process.exitCode.pipe(Effect.fork)

      // Race: process exit vs timeout
      const timeoutEffect = Effect.sleep(config.timeoutMs).pipe(
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
        yield* logToConsole(config.char.name, config.role, "TIMED OUT — interrupting")
      } else {
        timedOut = false
        const exitCode = "exitCode" in raceResult ? (raceResult as { exitCode: number }).exitCode : -1
        const elapsed = Math.round((Date.now() - start) / 1000)
        yield* logToConsole(config.char.name, config.role, `Process exited (code=${exitCode}) after ${elapsed}s`)
        // Process exited — wait for stream to finish draining buffered output
        yield* Fiber.join(streamFiber).pipe(Effect.catchAll(() => Effect.void))
        const stderr = yield* Fiber.join(stderrFiber).pipe(Effect.catchAll(() => Effect.succeed("")))
        if (stderr && stderr.trim()) {
          yield* logToConsole(config.char.name, config.role, `stderr: ${stderr.trim().slice(0, 500)}`)
        }
      }

      // Collect accumulated text
      const textParts = yield* Ref.get(textAccumulator)
      const output = textParts.join("\n")

      const durationMs = Date.now() - start

      return { output, timedOut, durationMs }
    }),
  ).pipe(
    Effect.mapError((e) =>
      e instanceof ClaudeError ? e : new ClaudeError("Process runner failed", e),
    ),
  )
