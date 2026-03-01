import { Context, Effect, Fiber, Layer, Scope, Stream, Chunk } from "effect"
import { Command, CommandExecutor } from "@effect/platform"
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs"

import { tmpdir } from "node:os"
import * as path from "node:path"

export type ClaudeModel = "opus" | "sonnet" | "haiku"

export class ClaudeError {
  readonly _tag = "ClaudeError"
  constructor(readonly message: string, readonly cause?: unknown) {}
}

export class Claude extends Context.Tag("Claude")<
  Claude,
  {
    /** Invoke claude -p on the host. Returns the full text output. */
    readonly invoke: (opts: {
      prompt: string
      model: ClaudeModel
      systemPrompt?: string
      outputFormat?: "text" | "json" | "stream-json"
      maxTurns?: number
    }) => Effect.Effect<string, ClaudeError>

    /** Run claude -p inside a Docker container via run-step.sh, returning a stream + exit handle. */
    readonly execInContainer: (opts: {
      containerId: string
      playerName: string
      prompt: string
      model: ClaudeModel
      systemPrompt?: string
      outputFormat?: "text" | "stream-json"
      allowedTools?: string[]
      env?: Record<string, string>
    }) => Effect.Effect<
      {
        stream: Stream.Stream<string, ClaudeError>
        waitForExit: Effect.Effect<{ exitCode: number; stderr: string }, ClaudeError>
      },
      ClaudeError,
      Scope.Scope
    >
  }
>() {}

/**
 * Write content to a temp file, returning its path.
 * Caller is responsible for cleanup.
 */
function writeTempFile(prefix: string, content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "roci-"))
  const filePath = path.join(dir, `${prefix}.txt`)
  writeFileSync(filePath, content)
  return filePath
}

function cleanupTempFile(filePath: string): void {
  try {
    unlinkSync(filePath)
  } catch {
    // ignore
  }
}

/**
 * Return a shell-safe literal using $'...' ANSI-C quoting.
 * Escapes backslashes, single quotes, and control characters so the
 * result can be embedded directly in a bash command string.
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

export const ClaudeLive = Layer.effect(
  Claude,
  Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor

    return Claude.of({
      invoke: (opts) =>
        Effect.scoped(
          Effect.gen(function* () {
            const promptFile = writeTempFile("prompt", opts.prompt)

            const args: string[] = [
              "--model", opts.model,
              "--output-format", opts.outputFormat ?? "text",
              "--dangerously-skip-permissions",
              "--no-session-persistence",
            ]

            // Disable thinking for non-opus models
            if (opts.model !== "opus") {
              args.push("--effort", "low")
            }

            if (opts.maxTurns) {
              args.push("--max-turns", String(opts.maxTurns))
            }

            // Build the shell command: pipe prompt via stdin
            // Unset CLAUDECODE to allow running from within a Claude Code session
            // System prompt goes via temp file too if present
            let shellCmd: string
            if (opts.systemPrompt) {
              const sysFile = writeTempFile("system", opts.systemPrompt)
              shellCmd = `unset CLAUDECODE; cat ${shellEscape(promptFile)} | claude -p ${args.join(" ")} --system-prompt "$(cat ${shellEscape(sysFile)})" ; r=$?; rm -rf ${shellEscape(path.dirname(sysFile))}; exit $r`
            } else {
              shellCmd = `unset CLAUDECODE; cat ${shellEscape(promptFile)} | claude -p ${args.join(" ")}`
            }

            const cmd = Command.make("bash", "-c", shellCmd)
            const process = yield* executor.start(cmd)

            const stdout = yield* process.stdout.pipe(
              Stream.decodeText(),
              Stream.runCollect,
              Effect.map(Chunk.join("")),
            )

            const stderr = yield* process.stderr.pipe(
              Stream.decodeText(),
              Stream.runCollect,
              Effect.map(Chunk.join("")),
            )

            const exitCode = yield* process.exitCode

            cleanupTempFile(promptFile)

            if (exitCode !== 0) {
              return yield* Effect.fail(
                new ClaudeError(
                  `claude exited with code ${exitCode}: ${stderr.trim().slice(0, 500)}`,
                ),
              )
            }

            if (!stdout.trim()) {
              return yield* Effect.fail(
                new ClaudeError(
                  `claude returned empty output. stderr: ${stderr.trim().slice(0, 500)}`,
                ),
              )
            }

            return stdout
          }),
        ).pipe(
          Effect.mapError((e) =>
            e instanceof ClaudeError ? e : new ClaudeError("Claude invocation failed", e),
          ),
        ),

      execInContainer: (opts) =>
        Effect.gen(function* () {
          const outputFormat = opts.outputFormat ?? "stream-json"

          // Extra flags forwarded to run-step.sh → claude -p
          const extraArgs: string[] = [
            "--model", opts.model,
            "--output-format", outputFormat,
            ...(outputFormat === "stream-json" ? ["--verbose"] : []),
            // Disable thinking for non-opus models
            ...(opts.model !== "opus" ? ["--effort", "low"] : []),
          ]

          if (opts.systemPrompt) {
            extraArgs.push("--system-prompt", shellEscape(opts.systemPrompt))
          }

          // Pipe prompt via stdin to docker exec -i → run-step.sh → claude -p
          const innerCmd = `/opt/scripts/run-step.sh ${opts.playerName} ${extraArgs.join(" ")}`
          const promptStream = Stream.encodeText(Stream.make(opts.prompt))

          // Build docker exec args, injecting env vars via -e flags
          const execArgs: string[] = ["exec", "-i"]
          if (opts.env) {
            for (const [key, val] of Object.entries(opts.env)) {
              execArgs.push("-e", `${key}=${val}`)
            }
          }
          execArgs.push(opts.containerId, "bash", "-c", innerCmd)

          const cmd = Command.make("docker", ...execArgs).pipe(
            Command.stdin(promptStream),
          )

          const process = yield* executor.start(cmd)

          // Fork stderr drain immediately so it runs in parallel with stdout consumption
          const stderrFiber = yield* process.stderr.pipe(
            Stream.decodeText(),
            Stream.runCollect,
            Effect.map(Chunk.join("")),
          ).pipe(Effect.fork)

          const stream = process.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.filter((line) => line.trim().length > 0),
            Stream.catchAll((e) => Stream.fail(new ClaudeError("Stream read error", e))),
          )

          const waitForExit = Effect.gen(function* () {
            const stderr = yield* Fiber.join(stderrFiber)
            const exitCode = yield* process.exitCode
            return { exitCode: Number(exitCode), stderr }
          }).pipe(
            Effect.mapError((e) =>
              e instanceof ClaudeError ? e : new ClaudeError("Wait for exit failed", e),
            ),
          )

          return { stream, waitForExit }
        }).pipe(
          Effect.mapError((e) =>
            e instanceof ClaudeError ? e : new ClaudeError("Container exec failed", e),
          ),
        ),
    })
  }),
)
