import { Context, Effect, Layer, Stream, Chunk } from "effect"
import { Command, CommandExecutor } from "@effect/platform"

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

export const ClaudeLive = Layer.effect(
  Claude,
  Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor

    return Claude.of({
      invoke: (opts) =>
        Effect.scoped(
          Effect.gen(function* () {
            const args = [
              "-p",
              "--model", opts.model,
              "--output-format", opts.outputFormat ?? "text",
            ]

            if (opts.systemPrompt) {
              args.push("--system-prompt", opts.systemPrompt)
            }

            if (opts.maxTurns) {
              args.push("--max-turns", String(opts.maxTurns))
            }

            args.push("--dangerously-skip-permissions")
            args.push(opts.prompt)

            const cmd = Command.make("claude", ...args)
            const process = yield* executor.start(cmd)

            const stdout = yield* process.stdout.pipe(
              Stream.decodeText(),
              Stream.runCollect,
              Effect.map(Chunk.join("")),
            )

            const exitCode = yield* process.exitCode
            if (exitCode !== 0) {
              const stderr = yield* process.stderr.pipe(
                Stream.decodeText(),
                Stream.runCollect,
                Effect.map(Chunk.join("")),
              )
              return yield* Effect.fail(
                new ClaudeError(`claude exited with code ${exitCode}: ${stderr.trim()}`),
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
            const claudeArgs = [
              "-p",
              "--model", opts.model,
              "--output-format", opts.outputFormat ?? "stream-json",
              "--dangerously-skip-permissions",
            ]

            if (opts.systemPrompt) {
              claudeArgs.push("--system-prompt", opts.systemPrompt)
            }

            if (opts.allowedTools) {
              claudeArgs.push("--allowedTools", opts.allowedTools.join(","))
            }

            claudeArgs.push(opts.prompt)

            const cmd = Command.make(
              "docker", "exec", opts.containerId,
              "claude", ...claudeArgs,
            )

            const process = yield* executor.start(cmd)

            return process.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.mapError((e) => new ClaudeError("Stream read error", e)),
            )
          }),
        ).pipe(
          Effect.mapError((e) =>
            e instanceof ClaudeError ? e : new ClaudeError("Container exec failed", e),
          ),
        ),
    })
  }),
)
