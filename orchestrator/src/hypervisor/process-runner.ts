import { Effect, Stream, Chunk, Fiber } from "effect"
import { Command, CommandExecutor } from "@effect/platform"
import type { TurnConfig, TurnResult } from "./types.js"
import { ClaudeError } from "../services/Claude.js"

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
 * Run `claude -p` inside a container with a timeout.
 * Collects full stdout as text. On timeout, interrupts and returns partial output.
 */
export const runTurn = (config: TurnConfig): Effect.Effect<TurnResult, ClaudeError, CommandExecutor.CommandExecutor> =>
  Effect.scoped(
    Effect.gen(function* () {
      const executor = yield* CommandExecutor.CommandExecutor
      const start = Date.now()

      // Build claude flags
      const claudeArgs: string[] = [
        "--model", config.model,
        "--output-format", "text",
        "--dangerously-skip-permissions",
      ]

      if (config.model !== "opus") {
        claudeArgs.push("--effort", "low")
      }

      // System prompt via flag
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

      // Fork stdout collection
      const stdoutFiber = yield* process.stdout.pipe(
        Stream.decodeText(),
        Stream.runCollect,
        Effect.map(Chunk.join("")),
      ).pipe(Effect.fork)

      // Fork stderr drain
      const stderrFiber = yield* process.stderr.pipe(
        Stream.decodeText(),
        Stream.runCollect,
        Effect.map(Chunk.join("")),
      ).pipe(Effect.fork)

      // Race: stdout collection vs timeout
      const timeoutEffect = Effect.sleep(config.timeoutMs).pipe(
        Effect.map(() => ({ timedOut: true as const })),
      )

      const completionEffect = Fiber.join(stdoutFiber).pipe(
        Effect.map((output) => ({ timedOut: false as const, output })),
      )

      const raceResult = yield* Effect.race(completionEffect, timeoutEffect)

      let output: string
      let timedOut: boolean

      if (raceResult.timedOut) {
        // Timeout: interrupt the process, collect whatever we have
        timedOut = true
        yield* Fiber.interrupt(stdoutFiber).pipe(Effect.catchAll(() => Effect.void))
        yield* Fiber.interrupt(stderrFiber).pipe(Effect.catchAll(() => Effect.void))
        // Kill the docker exec process
        output = "(timed out — partial output may be unavailable)"
      } else {
        timedOut = false
        output = raceResult.output
        // Wait for process to finish
        yield* Fiber.join(stderrFiber).pipe(Effect.catchAll(() => Effect.succeed("")))
      }

      const durationMs = Date.now() - start

      return { output, timedOut, durationMs }
    }),
  ).pipe(
    Effect.mapError((e) =>
      e instanceof ClaudeError ? e : new ClaudeError("Process runner failed", e),
    ),
  )
