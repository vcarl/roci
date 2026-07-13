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
import type { TurnConfig, TurnResult } from "#brain/stem/transport/types.js"
import { buildExecArgs } from "#brain/stem/transport/process-runner.js"
import { buildOpenCodeSessionCommand, openCodeBodyEnv, wrapWithTimeout } from "#brain/stem/transport/payload.js"
import { runTransport, bodySilenceTimeoutMs } from "#brain/stem/transport/transport.js"
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
      // Conscious/opencode is the tier that wedges on a stuck local-model request
      // (silent for many minutes while the wall clock still has ~an hour). Enable
      // silence detection so the transport reaps it in minutes; the retry/abort
      // state machine lives in runOpenCodeSessionTurn below.
      silenceTimeoutMs: bodySilenceTimeoutMs(),
    })
    yield* emitBodyExchange(config, result.output)
    return result
  })

/**
 * Max silence attempts per turn: the first attempt plus ONE retry. A turn that
 * hangs twice is aborted with a structured ClaudeError (see runOpenCodeSessionTurn).
 */
export const MAX_SILENCE_ATTEMPTS = 2

/**
 * Best-effort reap of an in-container turn orphaned by a silence-kill. `docker exec`
 * does NOT signal-forward the death of its host-side client (see payload.ts), so the
 * silence-killed opencode keeps running inside the container — and it still holds the
 * connection to the single-request local model server, which would wedge the retry
 * (and every other player's conscious turn) too. Kill any in-container process whose
 * working directory is (under) THIS player's dir, so the reap is scoped to this
 * player in the shared container and covers the opencode process plus its tool
 * children. Never fails the turn — a kill error degrades to a plain retry/abort.
 */
export const killWedgedInContainerTurn = (
  containerId: string,
  playerName: string,
): Effect.Effect<void, never, CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    const dir = `/work/players/${playerName}`
    // POSIX sh: match each pid's cwd symlink against this player's dir (or a subdir)
    // and SIGKILL it. `${d##*/}` is the bare pid; all `$(...)`/`${...}` are shell,
    // escaped so they survive the JS template literal.
    const script =
      `for d in /proc/[0-9]*; do ` +
      `c=$(readlink "$d/cwd" 2>/dev/null) || continue; ` +
      `case "$c" in "${dir}"|"${dir}"/*) kill -9 "\${d##*/}" 2>/dev/null || true;; esac; ` +
      `done`
    const command = Command.make("docker", "exec", containerId, "sh", "-c", script)
    yield* Command.exitCode(command)
  }).pipe(Effect.catchAll(() => Effect.void))

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
    // immediately-closing stdin below is forwarded by `timeout` unchanged. Built
    // once and reused across retries: a resume turn re-resumes the same session; a
    // first turn re-opens a fresh session (the old, silence-killed half is orphaned
    // and reaped by killWedgedInContainerTurn before the retry runs).
    const innerCmd = wrapWithTimeout(buildOpenCodeSessionCommand(config, resume), config.timeoutMs)

    const runAttempt = () =>
      runOverTransport(config, {
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

    // Silence-recovery state machine (conscious equivalent of the instrumented
    // tiers' graceful degradation). A turn that goes silent past the threshold is
    // killed by the transport (result.hung) — reap the in-container orphan to free
    // the single-request model server, then retry ONCE. A second hang aborts with a
    // structured ClaudeError, which ConsciousThought.turn's catchAll converts into a
    // failed-style result whose text flows into the step report → evaluate/replan,
    // so the brain re-plans instead of freezing on the wedge.
    let attempt = 1
    let result = yield* runAttempt()
    while (result.hung) {
      const silentSec = Math.round((result.silentMs ?? 0) / 1000)
      yield* killWedgedInContainerTurn(config.containerId, config.playerName)
      if (attempt >= MAX_SILENCE_ATTEMPTS) {
        yield* logToConsole(
          config.char.name,
          config.role,
          `conscious turn hung ${attempt}x (no model output for ~${silentSec}s each); aborting turn to replan`,
          "warn",
        )
        return yield* Effect.fail(
          new ClaudeError(
            `OpenCode conscious turn hung ${attempt}x (no model output); aborted to replan`,
          ),
        )
      }
      yield* logToConsole(
        config.char.name,
        config.role,
        `conscious turn hung (no model output for ~${silentSec}s) on attempt ${attempt}; killed stuck request, retrying once`,
        "warn",
      )
      attempt++
      result = yield* runAttempt()
    }

    const sessionId = result.sessionId ?? resume?.sessionId
    if (!sessionId) {
      return yield* Effect.fail(new ClaudeError(sessionNotFoundMessage(resume)))
    }
    return { result, sessionId }
  }).pipe(
    Effect.mapError((e) => (e instanceof ClaudeError ? e : new ClaudeError("OpenCode session runner failed", e))),
  )
