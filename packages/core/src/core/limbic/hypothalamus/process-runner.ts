/**
 * Primary execution path for all domain-level agent invocations.
 *
 * `runTurn` composes a *payload* (the inner command + normalizer, per runtime —
 * see `payload.ts`) with the reusable *transport* (`docker exec` + stream + race
 * + kill — see `transport.ts`). It runs the agent inside the Docker container
 * with full tool access, streaming output, and a timeout, returning the
 * accumulated text.
 */

import { Effect, Stream } from "effect"
import { Command, CommandExecutor } from "@effect/platform"
import type { TurnConfig, TurnResult } from "./types.js"
import { ClaudeError } from "../../../services/Claude.js"
import { OAuthToken } from "../../../services/OAuthToken.js"
import { CharacterLog, logToConsole, logExchange } from "../../../logging/log-writer.js"
import { selectRuntime, buildInnerCommand, normalizerFor, buildOpenCodeSessionCommand, openCodeBodyEnv, wrapWithTimeout, OPENCODE_DISABLE_NETWORK_ENV } from "./payload.js"
import { runTransport } from "./transport.js"
import { normalizeOpenCode, type InternalEvent } from "../../../logging/stream-normalizer.js"

/** Build the `docker exec` args: working dir, env (incl. OAuth token), inner command. */
export function buildExecArgs(config: TurnConfig, innerCmd: string, token: string): string[] {
  const execArgs: string[] = ["exec", "-i", "-w", `/work/players/${config.playerName}`]
  if (config.env) {
    for (const [key, val] of Object.entries(config.env)) {
      if (key === "CLAUDE_CODE_OAUTH_TOKEN") continue
      execArgs.push("-e", `${key}=${val}`)
    }
  }
  execArgs.push("-e", `CLAUDE_CODE_OAUTH_TOKEN=${token}`)
  execArgs.push(config.containerId, "bash", "-c", innerCmd)
  return execArgs
}

/** Archive the body turn's prompt+output (debug level; jsonl-complete). Never crashes the turn. */
const emitBodyExchange = (config: TurnConfig, output: string) =>
  logExchange(config.char.name, "body", "act", config.prompt, output).pipe(Effect.catchAll(() => Effect.void))

/**
 * Shared runner body: resolve OAuth, build the `docker exec` args, log the exec
 * line (token redacted), attach the given stdin, run the transport, and archive
 * the body exchange. The two public runners differ only in the inner command, the
 * exec env, the stdin, and the transport's normalize/runtimeTag/captureFromRaw —
 * all supplied via `opts`. Callers add their own `mapError` so failure messages
 * stay distinct.
 */
const runOverTransport = (
  config: TurnConfig,
  opts: {
    innerCmd: string
    env: Record<string, string> | undefined
    stdin: Stream.Stream<Uint8Array>
    normalize: (raw: Record<string, unknown>) => InternalEvent[]
    runtimeTag: string
    captureFromRaw?: (raw: Record<string, unknown>) => string | null
    /** runTurn logs an extra "oauth token resolved" diagnostic; the session path does not. */
    logTokenResolved?: boolean
  },
) =>
  Effect.gen(function* () {
    const oauthToken = yield* OAuthToken
    const { token } = yield* oauthToken.getToken

    const execArgs = buildExecArgs({ ...config, env: opts.env }, opts.innerCmd, token)

    if (opts.logTokenResolved) {
      // Diagnostic: confirm a token was resolved without leaking any of its value.
      yield* logToConsole(
        config.char.name,
        config.role,
        `oauth token resolved=${token.length > 0}`,
        "debug",
      )
    }
    // Log the full docker exec command (redact token values).
    const redactedArgs = execArgs.map((a) =>
      a.includes("CLAUDE_CODE_OAUTH_TOKEN=") ? "CLAUDE_CODE_OAUTH_TOKEN=<redacted>" : a,
    )
    yield* logToConsole(config.char.name, config.role, `docker ${redactedArgs.join(" ")}`, "debug")

    const command = Command.make("docker", ...execArgs).pipe(Command.stdin(opts.stdin))

    const result = yield* runTransport({
      command,
      normalize: opts.normalize,
      runtimeTag: opts.runtimeTag,
      char: config.char,
      role: config.role,
      timeoutMs: config.timeoutMs,
      captureFromRaw: opts.captureFromRaw,
    })
    yield* emitBodyExchange(config, result.output)
    return result
  })

/**
 * Run one turn: build the payload, inject OAuth, exec inside the container,
 * stream the result through the transport. Signature/behavior unchanged from the
 * pre-split version — all existing callers are untouched.
 */
export const runTurn = (config: TurnConfig): Effect.Effect<
  TurnResult,
  ClaudeError,
  CommandExecutor.CommandExecutor | CharacterLog | OAuthToken
> =>
  Effect.gen(function* () {
    const runtime = selectRuntime(config)
    // Issue 3: self-bound the in-container process so a host-side timeout/interrupt
    // (which `docker exec` does not signal-forward) cannot orphan the agent.
    const innerCmd = wrapWithTimeout(buildInnerCommand(config, runtime), config.timeoutMs)
    // opencode turns must skip the firewall-blocked models.dev registry fetch and
    // fall back to the configured local provider (see openCodeBodyEnv / the env doc).
    const execEnv =
      runtime === "opencode" ? { ...config.env, ...OPENCODE_DISABLE_NETWORK_ENV } : config.env

    // NOTE: runtimeTag is intentionally "claude" for both runtimes here, matching
    // pre-split behavior (Phase 1 is behavior-preserving). Phase 2 corrects the
    // tag for the opencode payload.
    return yield* runOverTransport(config, {
      innerCmd,
      env: execEnv,
      stdin: Stream.encodeText(Stream.make(config.prompt)),
      normalize: normalizerFor(runtime),
      runtimeTag: "claude",
      logTokenResolved: true,
    })
  }).pipe(
    Effect.mapError((e) =>
      e instanceof ClaudeError ? e : new ClaudeError("Process runner failed", e),
    ),
  )

/** Capture predicate for the OpenCode sessionID field on a raw stream line. */
export const firstSessionId = (raw: Record<string, unknown>): string | null =>
  typeof raw.sessionID === "string" ? raw.sessionID : null

/**
 * Message for the "no session id" failure. The resume path is distinct from the
 * first-turn path so a lost-session resume is diagnosable (and string-matchable in 4c).
 */
export function sessionNotFoundMessage(resume?: { sessionId: string }): string {
  return resume
    ? `OpenCode resume failed: session id not available for session ${resume.sessionId}`
    : "OpenCode session id not captured from run output"
}

/**
 * Run one conscious-tier OpenCode session turn over the shared docker-exec
 * transport. First turn (no `resume`) opens the session with the project-local
 * agent + local model and captures the new session id; a resume turn continues
 * `resume.sessionId`. Returns the turn result plus the (captured or carried)
 * session id. Fails with ClaudeError if a first turn yields no session id.
 */
export const runOpenCodeSessionTurn = (
  config: TurnConfig,
  resume?: { sessionId: string },
): Effect.Effect<
  { result: TurnResult; sessionId: string },
  ClaudeError,
  CommandExecutor.CommandExecutor | CharacterLog | OAuthToken
> =>
  Effect.gen(function* () {
    // Issue 3: self-bound the in-container process (see runTurn). The empty,
    // immediately-closing stdin below is forwarded by `timeout` unchanged.
    const innerCmd = wrapWithTimeout(buildOpenCodeSessionCommand(config, resume), config.timeoutMs)

    const result = yield* runOverTransport(config, {
      innerCmd,
      // Inject the env that lets opencode skip the firewall-blocked models.dev fetch
      // and fall back to the configured local provider (see openCodeBodyEnv).
      env: openCodeBodyEnv(config),
      // opencode `run` blocks at init reading stdin when stdin is an open pipe with no
      // EOF: `docker exec -i` (buildExecArgs) keeps stdin open, and Effect does not close
      // an unconfigured stdin, so opencode waits forever — before ever creating a session
      // or calling the model (the "init then silence" body hang). The prompt is passed as
      // a CLI arg, not via stdin, so feed an empty, immediately-closing stdin to signal
      // EOF and let opencode proceed.
      stdin: Stream.empty,
      normalize: normalizeOpenCode,
      runtimeTag: "opencode",
      captureFromRaw: firstSessionId,
    })

    const sessionId = result.sessionId ?? resume?.sessionId
    if (!sessionId) {
      return yield* Effect.fail(new ClaudeError(sessionNotFoundMessage(resume)))
    }
    return { result, sessionId }
  }).pipe(
    Effect.mapError((e) => (e instanceof ClaudeError ? e : new ClaudeError("OpenCode session runner failed", e))),
  )
