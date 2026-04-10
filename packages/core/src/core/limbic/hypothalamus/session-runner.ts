/**
 * Persistent claude --channels session runner.
 *
 * `runSession` starts a long-lived `claude --channels` process inside a Docker
 * container backed by an MCP channel server (roci-channel). The caller gets back
 * a `SessionHandle` immediately; the session runs concurrently and can receive
 * events via `pushEvent`, be awaited via `join`, or be terminated via `interrupt`.
 */

import { Effect, Stream, Chunk, Fiber, Scope } from "effect"
import { Command, CommandExecutor } from "@effect/platform"
import type { SessionConfig, SessionResult } from "./types.js"
import { ClaudeError } from "../../../services/Claude.js"
import { normalizeClaude } from "../../../logging/stream-normalizer.js"
import { demuxEvents, printRaw } from "../../../logging/log-demux.js"
import { OAuthToken } from "../../../services/OAuthToken.js"
import { CharacterLog } from "../../../logging/log-writer.js"
import { logToConsole } from "../../../logging/console-renderer.js"

/** Default channel port if not specified in config. */
const DEFAULT_CHANNEL_PORT = 3284

/**
 * Shell-safe literal using $'...' ANSI-C quoting.
 * Copied from process-runner.ts (not exported there).
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

export interface SessionHandle {
  pushEvent(content: string, meta?: Record<string, string>): Effect.Effect<void, never, CommandExecutor.CommandExecutor>
  join: Effect.Effect<SessionResult, never, never>
  interrupt: Effect.Effect<void, never, never>
}

/**
 * Start a persistent `claude --channels` session inside a Docker container.
 * Returns a `SessionHandle` immediately; the session runs concurrently.
 */
export const runSession = (config: SessionConfig): Effect.Effect<
  SessionHandle,
  ClaudeError,
  CommandExecutor.CommandExecutor | CharacterLog | OAuthToken
> =>
  Effect.gen(function* () {
      const executor = yield* CommandExecutor.CommandExecutor
      const start = Date.now()
      const oauthToken = yield* OAuthToken
      const { token } = yield* oauthToken.getToken
      const log = yield* CharacterLog

      const channelPort = config.channelPort ?? DEFAULT_CHANNEL_PORT
      const playerDir = `/work/players/${config.playerName}`

      // ── Step 1: Write .mcp.json and clear session-result.json ──────────────

      const mcpJson = JSON.stringify({
        mcpServers: {
          "roci-channel": {
            command: "bun",
            args: ["/work/bin/roci-channel.ts"],
            env: {
              ROCI_CHANNEL_PORT: String(channelPort),
              ROCI_PLAYER_DIR: playerDir,
            },
          },
        },
      })

      // Escape for use in sh -c "echo '...' > file" — replace embedded single
      // quotes with '\'' (end-quote, literal-quote, re-open-quote).
      const escapedMcp = mcpJson.replace(/'/g, `'\\''`)
      const setupCmd = `echo '${escapedMcp}' > ${playerDir}/.mcp.json && rm -f ${playerDir}/session-result.json`

      const setupArgs = ["exec", config.containerId, "sh", "-c", setupCmd]
      yield* Effect.scoped(Effect.gen(function* () {
        const setupProcess = yield* executor.start(Command.make("docker", ...setupArgs))
        const setupExit = yield* setupProcess.exitCode.pipe(Effect.catchAll(() => Effect.succeed(1 as CommandExecutor.ExitCode)))
        if (Number(setupExit) !== 0) {
          const setupStderr = yield* setupProcess.stderr.pipe(
            Stream.decodeText(),
            Stream.runCollect,
            Effect.map(Chunk.join("")),
            Effect.catchAll(() => Effect.succeed("")),
          )
          yield* logToConsole(config.char.name, "session", `Failed to write .mcp.json: ${setupStderr.trim()}`)
        }
      }))

      // ── Step 2: Build claude --channels args ───────────────────────────────

      const claudeArgs: string[] = [
        "--channels", "server:roci-channel",
        "--dangerously-load-development-channels",
        "--permission-mode", "bypassPermissions",
        "--output-format", "stream-json",
        "--verbose",
        "--model", config.model,
        "--system-prompt", config.systemPrompt,
      ]

      if (config.addDirs) {
        for (const dir of config.addDirs) {
          claudeArgs.push("--add-dir", dir)
        }
      }

      // ── Step 3: Build docker exec args ────────────────────────────────────

      const execArgs: string[] = ["exec", "-w", playerDir]
      if (config.env) {
        for (const [key, val] of Object.entries(config.env)) {
          if (key === "CLAUDE_CODE_OAUTH_TOKEN") continue
          execArgs.push("-e", `${key}=${val}`)
        }
      }
      execArgs.push("-e", `CLAUDE_CODE_OAUTH_TOKEN=${token}`)
      execArgs.push(config.containerId, "claude", ...claudeArgs)

      // Diagnostic logging
      yield* logToConsole(config.char.name, "session", `token len=${token.length} prefix=${token.slice(0, 15)}... suffix=...${token.slice(-10)}`)
      const redactedArgs = execArgs.map(a =>
        a.includes("CLAUDE_CODE_OAUTH_TOKEN=") ? "CLAUDE_CODE_OAUTH_TOKEN=<redacted>" : a
      )
      yield* logToConsole(config.char.name, "session", `docker ${redactedArgs.join(" ")}`)

      // No stdin pipe — persistent sessions receive input via channel events
      // Provide an open scope: the process lifetime is managed by fiber interruption
      // and Docker container lifecycle, not by Effect scope finalizers.
      const cmd = Command.make("docker", ...execArgs)
      const openScope = yield* Scope.make()
      const process = yield* Effect.provideService(executor.start(cmd), Scope.Scope, openScope)

      // ── Step 4: Fork fibers ───────────────────────────────────────────────

      // Drain stderr
      const stderrFiber = yield* process.stderr.pipe(
        Stream.decodeText(),
        Stream.runCollect,
        Effect.map(Chunk.join("")),
        Effect.catchAll(() => Effect.succeed("")),
      ).pipe(Effect.fork)

      // Stream stdout: log raw lines, parse stream-json, pass to demuxEvents
      const streamFiber = yield* process.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line.trim().length > 0),
        Stream.mapEffect((line) =>
          Effect.gen(function* () {
            yield* log.raw(config.char, line).pipe(Effect.catchAll(() => Effect.void))
            const raw = parseStreamJson(line)
            if (raw) {
              const events = normalizeClaude(raw)
              yield* demuxEvents(config.char, events, "body")
            } else {
              printRaw(config.char.name, "session", line)
            }
          }),
        ),
        Stream.runDrain,
        Effect.catchAll(() => Effect.void),
      ).pipe(Effect.fork)

      // Wait for process exit (exitCode error channel is PlatformError; catch it)
      const exitFiber = yield* process.exitCode.pipe(
        Effect.catchAll(() => Effect.succeed(-1 as CommandExecutor.ExitCode)),
      ).pipe(Effect.fork)

      // ── Step 5: Fork session lifecycle fiber ──────────────────────────────

      const sessionFiber: Fiber.RuntimeFiber<SessionResult, never> = yield* Effect.fork(
        Effect.gen(function* () {
          // Race: process exits vs timeout
          const timeoutEffect = Effect.sleep(config.sessionTimeoutMs).pipe(
            Effect.map(() => ({ timedOut: true as const })),
          )
          const completionEffect = Fiber.join(exitFiber).pipe(
            Effect.map((exitCode) => ({ timedOut: false as const, exitCode: Number(exitCode) })),
          )

          const raceResult = yield* Effect.race(completionEffect, timeoutEffect)

          // Interrupt remaining I/O fibers
          yield* Fiber.interrupt(exitFiber).pipe(Effect.catchAll(() => Effect.void))
          yield* Fiber.interrupt(streamFiber).pipe(Effect.catchAll(() => Effect.void))
          yield* Fiber.interrupt(stderrFiber).pipe(Effect.catchAll(() => Effect.void))

          const durationMs = Date.now() - start

          // Try to read session-result.json from inside the container.
          // Use Command.string which handles the scope internally.
          const resultJsonCmd = Command.make(
            "docker", "exec",
            config.containerId,
            "cat",
            `${playerDir}/session-result.json`,
          )
          const resultText = yield* Command.string(resultJsonCmd).pipe(
            Effect.catchAll(() => Effect.succeed("")),
          )

          let fileReason: "completed" | "unachievable" | undefined
          let fileSummary: string | undefined

          if (resultText.trim()) {
            const parsed = parseStreamJson(resultText.trim())
            if (parsed && typeof parsed.reason === "string") {
              if (parsed.reason === "completed" || parsed.reason === "unachievable") {
                fileReason = parsed.reason
              }
              if (typeof parsed.summary === "string") {
                fileSummary = parsed.summary
              }
            }
          }

          if (raceResult.timedOut) {
            yield* logToConsole(config.char.name, "session", `Session timed out after ${durationMs}ms`)
            return {
              reason: "killed" as const,
              summary: fileSummary,
              durationMs,
            }
          }

          const exitCode = "exitCode" in raceResult ? (raceResult as { exitCode: number }).exitCode : -1
          const elapsed = Math.round(durationMs / 1000)
          yield* logToConsole(config.char.name, "session", `Session exited (code=${exitCode}) after ${elapsed}s`)

          if (fileReason) {
            return { reason: fileReason, summary: fileSummary, durationMs }
          }

          // Process exited without a result file — treat as crash
          return { reason: "crashed" as const, summary: fileSummary, durationMs }
        }).pipe(Effect.catchAll((e) => Effect.succeed({
          reason: "crashed" as const,
          summary: `Internal error: ${e}`,
          durationMs: Date.now() - start,
        }))),
      )

      // ── Step 6: Return handle ─────────────────────────────────────────────

      const handle: SessionHandle = {
        pushEvent: (content: string, meta?: Record<string, string>) =>
          Effect.gen(function* () {
            const payload = JSON.stringify({ content, ...(meta ?? {}) })
            const curlCmd = Command.make(
              "docker", "exec",
              config.containerId,
              "curl", "-sf", "-X", "POST",
              `http://127.0.0.1:${channelPort}`,
              "-H", "Content-Type: application/json",
              "-d", payload,
            )
            const curlExit = yield* Command.exitCode(curlCmd).pipe(
              Effect.catchAll((e) =>
                Effect.gen(function* () {
                  yield* logToConsole(config.char.name, "session", `pushEvent curl failed: ${e}`)
                  return 1 as CommandExecutor.ExitCode
                }),
              ),
            )
            if (Number(curlExit) !== 0) {
              yield* logToConsole(config.char.name, "session", `pushEvent: curl exited with code ${curlExit}`)
            }
          }),

        join: Fiber.join(sessionFiber),

        interrupt: Effect.gen(function* () {
          yield* Fiber.interrupt(sessionFiber).pipe(Effect.catchAll(() => Effect.void))
          yield* Fiber.interrupt(exitFiber).pipe(Effect.catchAll(() => Effect.void))
          yield* Fiber.interrupt(streamFiber).pipe(Effect.catchAll(() => Effect.void))
          yield* Fiber.interrupt(stderrFiber).pipe(Effect.catchAll(() => Effect.void))
        }),
      }

      return handle
    }).pipe(
    Effect.mapError((e) =>
      e instanceof ClaudeError ? e : new ClaudeError("Session runner failed", e),
    ),
  )
