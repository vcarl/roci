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
import { CharacterLog, logToConsole } from "../../../logging/log-writer.js"
import { selectRuntime, buildInnerCommand, normalizerFor } from "./payload.js"
import { runTransport } from "./transport.js"
import { buildSdkInnerCommand, buildSdkStdin, sdkEnv } from "./sdk-payload.js"
import { normalizeSdk } from "../../../logging/stream-normalizer.js"

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
    yield* logToConsole(config.char.name, config.role, `docker ${redactedArgs.join(" ")}`)

    const promptStream = Stream.encodeText(Stream.make(config.prompt))
    const command = Command.make("docker", ...execArgs).pipe(Command.stdin(promptStream))

    // NOTE: runtimeTag is intentionally "claude" for both runtimes here, matching
    // pre-split behavior (Phase 1 is behavior-preserving). Phase 2 corrects the
    // tag for the opencode payload.
    return yield* runTransport({
      command,
      normalize: normalizerFor(runtime),
      runtimeTag: "claude",
      char: config.char,
      role: config.role,
      timeoutMs: config.timeoutMs,
    })
  }).pipe(
    Effect.mapError((e) =>
      e instanceof ClaudeError ? e : new ClaudeError("Process runner failed", e),
    ),
  )

/**
 * Run a frontier-worker SDK turn run-to-completion. Builds the NDJSON stdin
 * (`task` then `end`), the `docker exec … node sdk-runner.mjs` command (with the
 * SDK env + OAuth token injected via buildExecArgs), and delegates streaming /
 * race / kill to the shared transport with normalizeSdk. Phase 2: no steering.
 */
export const runSdkTurn = (config: TurnConfig): Effect.Effect<
  TurnResult,
  ClaudeError,
  CommandExecutor.CommandExecutor | CharacterLog | OAuthToken
> =>
  Effect.gen(function* () {
    const oauthToken = yield* OAuthToken
    const { token } = yield* oauthToken.getToken

    const innerCmd = buildSdkInnerCommand()
    // Inject the SDK env through buildExecArgs's custom-env loop.
    const execArgs = buildExecArgs({ ...config, env: sdkEnv(config) }, innerCmd, token)

    const redactedArgs = execArgs.map((a) =>
      a.includes("CLAUDE_CODE_OAUTH_TOKEN=") ? "CLAUDE_CODE_OAUTH_TOKEN=<redacted>" : a,
    )
    yield* logToConsole(config.char.name, config.role, `docker ${redactedArgs.join(" ")}`)

    const stdin = Stream.encodeText(Stream.make(buildSdkStdin(config.prompt)))
    const command = Command.make("docker", ...execArgs).pipe(Command.stdin(stdin))

    return yield* runTransport({
      command,
      normalize: normalizeSdk,
      runtimeTag: "sdk",
      char: config.char,
      role: config.role,
      timeoutMs: config.timeoutMs,
    })
  }).pipe(
    Effect.mapError((e) => (e instanceof ClaudeError ? e : new ClaudeError("SDK runner failed", e))),
  )
