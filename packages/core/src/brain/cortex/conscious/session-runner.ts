/**
 * Conscious-tier OpenCode session executor.
 *
 * Split out of `brain/transport/process-runner.ts` (fresh blame — this is a code
 * extraction, not a `git mv`). Runs a conscious session turn over the shared
 * docker-exec transport: it composes the OpenCode session *payload* (per
 * `payload.ts`) with the reusable *transport* (`runTransport` — `docker exec` +
 * stream + race + kill), reaching DOWN into `../../transport/**` (the allowed
 * cortex→transport edge). It shares `buildExecArgs` with `process-runner.ts`; the
 * per-turn exec/log/archive wrapper (`runOverTransport`) is a local copy so this
 * cortex module stands on the public transport primitives rather than a private
 * transport-internal helper.
 */

import { Effect, Stream } from "effect"
import { Command, CommandExecutor } from "@effect/platform"
import type { TurnConfig, TurnResult } from "../../transport/types.js"
import { buildExecArgs } from "../../transport/process-runner.js"
import { buildOpenCodeSessionCommand, openCodeBodyEnv, wrapWithTimeout } from "../../transport/payload.js"
import { runTransport } from "../../transport/transport.js"
import { ClaudeError } from "../../../services/Claude.js"
import { OAuthToken } from "../../../services/OAuthToken.js"
import { CharacterLog, logToConsole, logExchange } from "../../../logging/log-writer.js"
import { normalizeOpenCode, type InternalEvent } from "../../../logging/stream-normalizer.js"

/** Archive the body turn's prompt+output (debug level; jsonl-complete). Never crashes the turn. */
const emitBodyExchange = (config: TurnConfig, output: string) =>
  logExchange(config.char.name, "body", "act", config.prompt, output).pipe(Effect.catchAll(() => Effect.void))

/**
 * Shared runner body: resolve OAuth, build the `docker exec` args, log the exec
 * line (token redacted), attach the given stdin, run the transport, and archive
 * the body exchange. Mirrors `process-runner.ts`'s helper of the same name; the
 * session path supplies its own inner command, exec env, stdin, and
 * normalize/runtimeTag/captureFromRaw via `opts`.
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
