import { Context, Effect, Layer, Stream, Chunk } from "effect"
import { Command, CommandExecutor } from "@effect/platform"
import { writeFileSync, readFileSync, unlinkSync, mkdtempSync } from "node:fs"
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

    /** Run claude -p inside a Docker container, returning a stream of output lines. */
    readonly execInContainer: (opts: {
      containerId: string
      prompt: string
      model: ClaudeModel
      systemPrompt?: string
      outputFormat?: "text" | "stream-json"
      allowedTools?: string[]
    }) => Effect.Effect<Stream.Stream<string, ClaudeError>, ClaudeError>
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

/** Escape single quotes for use inside a bash single-quoted string */
function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''")
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
            ]

            if (opts.maxTurns) {
              args.push("--max-turns", String(opts.maxTurns))
            }

            // Build the shell command: pipe prompt via stdin
            // Unset CLAUDECODE to allow running from within a Claude Code session
            // System prompt goes via temp file too if present
            let shellCmd: string
            if (opts.systemPrompt) {
              const sysFile = writeTempFile("system", opts.systemPrompt)
              shellCmd = `unset CLAUDECODE; cat '${shellEscape(promptFile)}' | claude -p ${args.join(" ")} --system-prompt "$(cat '${shellEscape(sysFile)}')" ; r=$?; rm -rf '${shellEscape(path.dirname(sysFile))}'; exit $r`
            } else {
              shellCmd = `unset CLAUDECODE; cat '${shellEscape(promptFile)}' | claude -p ${args.join(" ")}`
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
        Effect.scoped(
          Effect.gen(function* () {
            const promptFile = writeTempFile("prompt", opts.prompt)
            const systemFile = opts.systemPrompt
              ? writeTempFile("system", opts.systemPrompt)
              : null

            const claudeArgs: string[] = [
              "--model", opts.model,
              "--output-format", opts.outputFormat ?? "stream-json",
              "--dangerously-skip-permissions",
            ]

            // Copy files into container
            const setup: string[] = [
              `docker cp '${shellEscape(promptFile)}' '${opts.containerId}:/tmp/_roci_prompt.txt'`,
            ]
            if (systemFile) {
              setup.push(
                `docker cp '${shellEscape(systemFile)}' '${opts.containerId}:/tmp/_roci_system.txt'`,
              )
              claudeArgs.push("--system-prompt", '"$(cat /tmp/_roci_system.txt)"')
            }

            // Run claude inside container, piping prompt via stdin
            const execCmd = `docker exec ${opts.containerId} bash -c 'cat /tmp/_roci_prompt.txt | claude -p ${claudeArgs.join(" ")}'`
            setup.push(execCmd)

            const shellCmd = setup.join(" && ")
            // Redirect stderr to a temp file so we can reliably capture it
            // (reading process.stderr after stdout drains loses data)
            const stderrFile = `/tmp/_roci_stderr_${Date.now()}.txt`
            const fullCmd = `${shellCmd} 2>${stderrFile}`
            const cmd = Command.make("bash", "-c", fullCmd)
            const process = yield* executor.start(cmd)

            // Collect ALL stdout inside the scope so the process stays alive.
            const stdoutLines = yield* process.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.filter((line) => line.trim().length > 0),
              Stream.runCollect,
            )

            const exitCode = yield* process.exitCode

            // Read stderr from the temp file
            let stderr = ""
            try {
              stderr = readFileSync(stderrFile, "utf-8")
              unlinkSync(stderrFile)
            } catch {
              // stderr file might not exist if the command never ran
            }

            cleanupTempFile(promptFile)
            if (systemFile) cleanupTempFile(systemFile)

            if (exitCode !== 0) {
              return yield* Effect.fail(
                new ClaudeError(
                  `Container exec exited with code ${exitCode}.\nCommand: ${shellCmd.slice(0, 300)}\nStderr: ${stderr.trim().slice(0, 500)}\nStdout lines: ${Chunk.size(stdoutLines)}`,
                ),
              )
            }

            return Stream.fromChunk(stdoutLines)
          }),
        ).pipe(
          Effect.mapError((e) =>
            e instanceof ClaudeError ? e : new ClaudeError("Container exec failed", e),
          ),
        ),
    })
  }),
)
