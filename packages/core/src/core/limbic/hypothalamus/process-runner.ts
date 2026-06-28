/**
 * Primary execution path for all domain-level agent invocations.
 *
 * `runTurn` composes a *payload* (the inner command + normalizer, per runtime —
 * see `payload.ts`) with the reusable *transport* (`docker exec` + stream + race
 * + kill — see `transport.ts`). It runs the agent inside the Docker container
 * with full tool access, streaming output, and a timeout, returning the
 * accumulated text.
 *
 * For orchestrator-internal tasks that don't need tool access, use
 * `Claude.invoke` from `services/Claude.ts` instead — that runs on the host.
 */

import { Effect, Stream } from "effect"
import { Command, CommandExecutor } from "@effect/platform"
import type { TurnConfig, TurnResult } from "./types.js"
import { ClaudeError } from "../../../services/Claude.js"
import { OAuthToken } from "../../../services/OAuthToken.js"
import { CharacterLog, logToConsole, logExchange } from "../../../logging/log-writer.js"
import { selectRuntime, buildInnerCommand, normalizerFor, buildOpenCodeSessionCommand, openCodeBodyEnv } from "./payload.js"
import { runTransport } from "./transport.js"
import { buildSdkInnerCommand, buildSdkStdin, sdkEnv } from "./sdk-payload.js"
import { normalizeSdk, normalizeOpenCode } from "../../../logging/stream-normalizer.js"

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
    const oauthToken = yield* OAuthToken
    const { token } = yield* oauthToken.getToken

    const runtime = selectRuntime(config)
    const innerCmd = buildInnerCommand(config, runtime)
    const execArgs = buildExecArgs(config, innerCmd, token)

    // Diagnostic: token prefix/suffix to verify it matches the saved file.
    yield* logToConsole(
      config.char.name,
      config.role,
      `token len=${token.length} prefix=${token.slice(0, 15)}... suffix=...${token.slice(-10)}`,
    )
    // Log the full docker exec command (redact token values).
    const redactedArgs = execArgs.map((a) =>
      a.includes("CLAUDE_CODE_OAUTH_TOKEN=") ? "CLAUDE_CODE_OAUTH_TOKEN=<redacted>" : a,
    )
    yield* logToConsole(config.char.name, config.role, `docker ${redactedArgs.join(" ")}`, "debug")

    const promptStream = Stream.encodeText(Stream.make(config.prompt))
    const command = Command.make("docker", ...execArgs).pipe(Command.stdin(promptStream))

    // NOTE: runtimeTag is intentionally "claude" for both runtimes here, matching
    // pre-split behavior (Phase 1 is behavior-preserving). Phase 2 corrects the
    // tag for the opencode payload.
    const result = yield* runTransport({
      command,
      normalize: normalizerFor(runtime),
      runtimeTag: "claude",
      char: config.char,
      role: config.role,
      timeoutMs: config.timeoutMs,
    })
    yield* emitBodyExchange(config, result.output)
    return result
  }).pipe(
    Effect.mapError((e) =>
      e instanceof ClaudeError ? e : new ClaudeError("Process runner failed", e),
    ),
  )

/** Shared SDK transport composition given a prebuilt stdin byte stream. */
const runSdkWithStdin = (
  config: TurnConfig,
  stdin: Stream.Stream<Uint8Array>,
): Effect.Effect<TurnResult, ClaudeError, CommandExecutor.CommandExecutor | CharacterLog | OAuthToken> =>
  Effect.gen(function* () {
    const oauthToken = yield* OAuthToken
    const { token } = yield* oauthToken.getToken

    const innerCmd = buildSdkInnerCommand()
    const execArgs = buildExecArgs({ ...config, env: sdkEnv(config) }, innerCmd, token)

    const redactedArgs = execArgs.map((a) =>
      a.includes("CLAUDE_CODE_OAUTH_TOKEN=") ? "CLAUDE_CODE_OAUTH_TOKEN=<redacted>" : a,
    )
    yield* logToConsole(config.char.name, config.role, `docker ${redactedArgs.join(" ")}`, "debug")

    const command = Command.make("docker", ...execArgs).pipe(Command.stdin(stdin))

    const result = yield* runTransport({
      command,
      normalize: normalizeSdk,
      runtimeTag: "sdk",
      char: config.char,
      role: config.role,
      timeoutMs: config.timeoutMs,
    })
    yield* emitBodyExchange(config, result.output)
    return result
  }).pipe(
    Effect.mapError((e) => (e instanceof ClaudeError ? e : new ClaudeError("SDK runner failed", e))),
  )

/**
 * Run a frontier-worker SDK turn run-to-completion. Builds the static NDJSON stdin
 * (`task` then `end`) and delegates to the shared transport composition.
 */
export const runSdkTurn = (config: TurnConfig): Effect.Effect<
  TurnResult,
  ClaudeError,
  CommandExecutor.CommandExecutor | CharacterLog | OAuthToken
> => runSdkWithStdin(config, Stream.encodeText(Stream.make(buildSdkStdin(config.prompt))))

/**
 * Run a steerable frontier-worker SDK session. The caller supplies the dynamic
 * stdin byte stream (typically buildSteeredStdinStream over a steering queue):
 * directives become `steer` lines mid-session, and shutting the queue down ends
 * it. Run-to-completion is the degenerate case (a stdin that is just task+end).
 */
export const runSdkSession = (
  config: TurnConfig,
  stdin: Stream.Stream<Uint8Array>,
): Effect.Effect<TurnResult, ClaudeError, CommandExecutor.CommandExecutor | CharacterLog | OAuthToken> =>
  runSdkWithStdin(config, stdin)

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
    const oauthToken = yield* OAuthToken
    const { token } = yield* oauthToken.getToken

    const innerCmd = buildOpenCodeSessionCommand(config, resume)
    // Inject the env that lets opencode skip the firewall-blocked models.dev fetch
    // and fall back to the configured local provider (see openCodeBodyEnv).
    const execArgs = buildExecArgs({ ...config, env: openCodeBodyEnv(config) }, innerCmd, token)

    const redactedArgs = execArgs.map((a) =>
      a.includes("CLAUDE_CODE_OAUTH_TOKEN=") ? "CLAUDE_CODE_OAUTH_TOKEN=<redacted>" : a,
    )
    yield* logToConsole(config.char.name, config.role, `docker ${redactedArgs.join(" ")}`, "debug")

    // opencode `run` blocks at init reading stdin when stdin is an open pipe with no
    // EOF: `docker exec -i` (buildExecArgs) keeps stdin open, and Effect does not close
    // an unconfigured stdin, so opencode waits forever — before ever creating a session
    // or calling the model (the "init then silence" body hang). The prompt is passed as
    // a CLI arg, not via stdin, so feed an empty, immediately-closing stdin to signal
    // EOF and let opencode proceed.
    const command = Command.make("docker", ...execArgs).pipe(Command.stdin(Stream.empty))

    const result = yield* runTransport({
      command,
      normalize: normalizeOpenCode,
      runtimeTag: "opencode",
      char: config.char,
      role: config.role,
      timeoutMs: config.timeoutMs,
      captureFromRaw: firstSessionId,
    })
    yield* emitBodyExchange(config, result.output)

    const sessionId = result.sessionId ?? resume?.sessionId
    if (!sessionId) {
      return yield* Effect.fail(new ClaudeError(sessionNotFoundMessage(resume)))
    }
    return { result, sessionId }
  }).pipe(
    Effect.mapError((e) => (e instanceof ClaudeError ? e : new ClaudeError("OpenCode session runner failed", e))),
  )
