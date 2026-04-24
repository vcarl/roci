/**
 * Persistent claude --channels session runner.
 *
 * `runSession` starts a long-lived `claude --channels` process inside a Docker
 * container backed by an MCP channel server (roci-channel). The caller gets back
 * a `SessionHandle` immediately; the session runs concurrently and can receive
 * events via `pushEvent`, be awaited via `join`, or be terminated via `interrupt`.
 */

import { Effect, Stream, Chunk, Fiber, Scope, Ref } from "effect"
import { Command, CommandExecutor } from "@effect/platform"
import type { SessionConfig, SessionResult } from "./types.js"
import { ClaudeError } from "../../../services/Claude.js"
import { normalizeClaude } from "../../../logging/stream-normalizer.js"
import { toUnifiedEvents, eventBase, type UnifiedEvent } from "../../../logging/events.js"
import { OAuthToken } from "../../../services/OAuthToken.js"
import { ProjectRoot } from "../../../services/ProjectRoot.js"
import * as path from "node:path"
import * as nodeFs from "node:fs"
import { CharacterLog, logToConsole } from "../../../logging/log-writer.js"

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
  pushEvent(content: string, meta?: Record<string, string>): Effect.Effect<void, unknown, CommandExecutor.CommandExecutor | CharacterLog>
  /** Drain and clear accumulated tool_use/tool_result events since last drain. */
  drainEvents(): Effect.Effect<UnifiedEvent[]>
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
  CommandExecutor.CommandExecutor | CharacterLog | OAuthToken | ProjectRoot
> =>
  Effect.gen(function* () {
      const executor = yield* CommandExecutor.CommandExecutor
      const start = Date.now()
      const oauthToken = yield* OAuthToken
      const { token } = yield* oauthToken.getToken
      const log = yield* CharacterLog
      const projectRoot = yield* ProjectRoot

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
      const setupCmd = `echo '${escapedMcp}' > ${playerDir}/.mcp.json && rm -f ${playerDir}/session-result.json && mkdir -p ${playerDir}/.claude ${playerDir}/logs && echo '{"channelsEnabled":true}' > ${playerDir}/.claude/settings.json`

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
        "--output-format", "stream-json", "--verbose",
        "--permission-mode", "bypassPermissions",
        "--model", config.model,
        "--system-prompt", config.systemPrompt,
      ]

      if (config.addDirs) {
        for (const dir of config.addDirs) {
          claudeArgs.push("--add-dir", dir)
        }
      }

      // ── Step 3: Build docker exec args ────────────────────────────────────

      const execArgs: string[] = ["exec", "-i", "-w", playerDir]
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

      // Pipe an initial stdin message so Claude Code starts in print mode and
      // then waits for channel events to arrive via the MCP channel server.
      const cmd = Command.make("docker", ...execArgs).pipe(
        Command.stdin(Stream.encodeText(Stream.make("Begin session. Your task will arrive via channel notification.\n")))
      )
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

      // Accumulate tool_use/tool_result events for drainEvents()
      const toolEventBuffer = yield* Ref.make<UnifiedEvent[]>([])

      // Stream stdout: log raw lines, parse stream-json, emit unified events
      const streamFiber = yield* process.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line.trim().length > 0),
        Stream.mapEffect((line) =>
          Effect.gen(function* () {
            const raw = parseStreamJson(line)
            if (raw) {
              const internal = normalizeClaude(raw)
              const unified = toUnifiedEvents(internal, config.char.name, "session", "claude")
              for (const event of unified) {
                yield* log.emit(config.char, event).pipe(Effect.catchAll(() => Effect.void))
                if (event.kind === "tool_use" || event.kind === "tool_result") {
                  yield* Ref.update(toolEventBuffer, (arr) => [...arr, event])
                }
              }
            } else if (line.trim()) {
              yield* log.emit(config.char, {
                ...eventBase(config.char.name, "session", "claude"),
                kind: "system",
                message: line,
              }).pipe(Effect.catchAll(() => Effect.void))
            }
          }),
        ),
        Stream.runDrain,
        Effect.catchAll(() => Effect.void),
      ).pipe(Effect.fork)

      // ── Activity.log tail — captures subagent tool calls from hooks ──
      const activityLogPath = path.resolve(
        projectRoot,
        "players",
        config.playerName,
        "logs",
        "activity.log",
      )

      // Clear stale activity.log from previous sessions
      try { nodeFs.writeFileSync(activityLogPath, "") } catch {}

      let activityOffset = 0

      const activityFiber = yield* Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep("2 seconds")

          const newLines = yield* Effect.try(() => {
            const stat = nodeFs.statSync(activityLogPath)
            if (stat.size <= activityOffset) return []

            const fd = nodeFs.openSync(activityLogPath, "r")
            const buf = Buffer.alloc(stat.size - activityOffset)
            nodeFs.readSync(fd, buf, 0, buf.length, activityOffset)
            nodeFs.closeSync(fd)
            activityOffset = stat.size

            return buf.toString("utf-8").split("\n").filter(l => l.trim())
          }).pipe(Effect.catchAll(() => Effect.succeed([] as string[])))

          for (const line of newLines) {
            const parsed = yield* Effect.try(() => JSON.parse(line) as Record<string, unknown>).pipe(
              Effect.catchAll(() => Effect.succeed(null)),
            )
            if (!parsed) continue

            let event: UnifiedEvent
            if (parsed.event === "subagent_start") {
              event = {
                ...eventBase(config.playerName, "session", "claude"),
                kind: "subagent_start",
                description: String((parsed.data as Record<string, unknown>)?.description ?? ""),
                data: parsed.data,
              }
            } else if (parsed.event === "subagent_stop") {
              event = {
                ...eventBase(config.playerName, "session", "claude"),
                kind: "subagent_stop",
                data: parsed.data,
              }
            } else {
              // PreToolUse hook event — tool call from subagent
              event = {
                ...eventBase(config.playerName, "subagent", "claude"),
                kind: "tool_use",
                tool: String(parsed.tool ?? "unknown"),
                id: "",
                input: parsed.input ?? {},
              }
            }

            yield* log.emit(config.char, event).pipe(Effect.catchAll(() => Effect.void))
          }
        }
      }).pipe(Effect.catchAll(() => Effect.void), Effect.fork)

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
          yield* Fiber.interrupt(activityFiber).pipe(Effect.catchAll(() => Effect.void))
          const stderr = yield* Fiber.join(stderrFiber).pipe(Effect.catchAll(() => Effect.succeed("")))
          if (stderr && stderr.trim()) {
            yield* logToConsole(config.char.name, "session", `stderr: ${stderr.trim().slice(0, 500)}`)
          }
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

        drainEvents: () => Ref.getAndSet(toolEventBuffer, []),

        join: Fiber.join(sessionFiber),

        interrupt: Effect.gen(function* () {
          yield* Fiber.interrupt(sessionFiber).pipe(Effect.catchAll(() => Effect.void))
          yield* Fiber.interrupt(exitFiber).pipe(Effect.catchAll(() => Effect.void))
          yield* Fiber.interrupt(streamFiber).pipe(Effect.catchAll(() => Effect.void))
          yield* Fiber.interrupt(stderrFiber).pipe(Effect.catchAll(() => Effect.void))
          yield* Fiber.interrupt(activityFiber).pipe(Effect.catchAll(() => Effect.void))
        }),
      }

      return handle
    }).pipe(
    Effect.mapError((e) =>
      e instanceof ClaudeError ? e : new ClaudeError("Session runner failed", e),
    ),
  )
