import { Context, Effect, Layer, Ref } from "effect"
import { spawnSync } from "node:child_process"
import * as process from "node:process"

import { ProjectRoot } from "./ProjectRoot.js"
import { DockerError } from "./Docker.js"
import {
  loadSavedToken,
  saveToken,
  extractTokenFromOutput,
  runSetupToken,
  isClaudeCliAvailable,
} from "../setup/oauth-token.js"
import { logToConsole } from "../logging/console-renderer.js"

export class OAuthToken extends Context.Tag("OAuthToken")<
  OAuthToken,
  {
    /** Read the current token from the Ref. Returns { token, version }. */
    readonly getToken: Effect.Effect<{ token: string; version: number }>
    /** Refresh the token. Takes the stale version — if already refreshed by another fiber, returns current without re-acquiring. */
    readonly refreshToken: (staleVersion: number) => Effect.Effect<string, DockerError>
  }
>() {}

/**
 * Acquire a fresh token via `claude setup-token`.
 * Returns the extracted token string or fails with DockerError.
 */
function acquireToken(projectRoot: string) {
  return Effect.gen(function* () {
    if (!isClaudeCliAvailable()) {
      return yield* Effect.fail(
        new DockerError(
          "'claude' CLI is not installed or not in PATH. Install it with: npm install -g @anthropic-ai/claude-code",
        ),
      )
    }

    yield* logToConsole("orchestrator", "main", "Acquiring OAuth token via 'claude setup-token'...")
    const { status, stdout } = runSetupToken()
    if (status !== 0) {
      return yield* Effect.fail(
        new DockerError("'claude setup-token' failed. Is the 'claude' CLI installed?"),
      )
    }

    const token = extractTokenFromOutput(stdout)
    if (!token) {
      return yield* Effect.fail(
        new DockerError("Could not extract token from 'claude setup-token' output."),
      )
    }

    saveToken(projectRoot, token)
    yield* logToConsole("orchestrator", "main", "OAuth token saved to .oauth-token")
    return token
  })
}

/**
 * Validate a token by running a quick `claude -p` ping.
 * Returns true if the token is valid, false otherwise.
 */
function validateToken(token: string): boolean {
  const result = spawnSync(
    "claude",
    ["-p", "--max-turns", "1", "--dangerously-skip-permissions", "--output-format", "text", "ping"],
    {
      env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token },
      encoding: "utf-8",
      timeout: 15000,
    },
  )
  return result.status === 0
}

export const OAuthTokenLive = Layer.effect(
  OAuthToken,
  Effect.gen(function* () {
    const projectRoot = yield* ProjectRoot

    // Step 1: Try to load a saved token
    let token = loadSavedToken(projectRoot)

    // Step 2: If no saved token, acquire one
    if (!token) {
      token = yield* acquireToken(projectRoot)
    }

    // Step 3: Validate the token
    if (!validateToken(token)) {
      yield* logToConsole("orchestrator", "main", "Saved token invalid, re-acquiring...")
      token = yield* acquireToken(projectRoot)
    } else {
      yield* logToConsole("orchestrator", "main", `OAuth token validated. len=${token.length} prefix=${token.slice(0, 15)}... suffix=...${token.slice(-10)}`)
    }

    // Step 4: Create Ref and Semaphore
    const tokenRef = yield* Ref.make({ token, version: 0 })
    const semaphore = yield* Effect.makeSemaphore(1)

    return OAuthToken.of({
      getToken: Ref.get(tokenRef),

      refreshToken: (staleVersion: number) =>
        semaphore.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(tokenRef)

            // Another fiber already refreshed
            if (current.version !== staleVersion) {
              return current.token
            }

            yield* logToConsole("orchestrator", "main", "Refreshing OAuth token...")
            const { status, stdout } = runSetupToken()
            if (status !== 0) {
              return yield* Effect.fail(
                new DockerError("'claude setup-token' failed during token refresh."),
              )
            }

            const newToken = extractTokenFromOutput(stdout)
            if (!newToken) {
              return yield* Effect.fail(
                new DockerError("Could not extract token from 'claude setup-token' output during refresh."),
              )
            }

            saveToken(projectRoot, newToken)
            yield* Ref.set(tokenRef, { token: newToken, version: current.version + 1 })
            yield* logToConsole("orchestrator", "main", "OAuth token refreshed and saved")
            return newToken
          }),
        ),
    })
  }),
)
