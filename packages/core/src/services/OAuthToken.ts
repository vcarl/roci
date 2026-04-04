import { Context, Effect, Layer, Ref } from "effect"
import { spawnSync } from "node:child_process"

import { ProjectRoot } from "./ProjectRoot.js"
import { DockerError } from "./Docker.js"
import {
  loadSavedToken,
  saveToken,
  extractTokenFromOutput,
  runSetupToken,
  isClaudeCliAvailable,
} from "./oauth-token.js"
import { logToConsole } from "../logging/console-renderer.js"

export class OAuthToken extends Context.Tag("OAuthToken")<
  OAuthToken,
  {
    /** Read the current token from the Ref. Returns { token, version }. */
    readonly getToken: Effect.Effect<{ token: string; version: number }>
    /** Refresh the token. Takes the stale version �� if already refreshed by another fiber, returns current without re-acquiring. */
    readonly refreshToken: (staleVersion: number) => Effect.Effect<string, DockerError>
    /** Validate the token by running a ping inside a Docker container. Returns true if valid. */
    readonly validateInContainer: (containerId: string) => Effect.Effect<boolean>
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
 * Validate a token by running `claude -p "ping"` inside a Docker container.
 * This matches production usage — the same binary, same env, same network.
 */
function validateTokenInContainer(token: string, containerId: string): boolean {
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-e", `CLAUDE_CODE_OAUTH_TOKEN=${token}`,
      containerId,
      "claude", "-p", "--bare", "--permission-mode", "bypassPermissions",
      "--output-format", "text", "ping",
    ],
    {
      encoding: "utf-8",
      timeout: 30000,
    },
  )
  return result.status === 0
}

export const OAuthTokenLive = Layer.effect(
  OAuthToken,
  Effect.gen(function* () {
    const projectRoot = yield* ProjectRoot

    // Step 1: Try to load a saved token, acquire if missing
    let token = loadSavedToken(projectRoot)
    if (!token) {
      token = yield* acquireToken(projectRoot)
    }
    yield* logToConsole("orchestrator", "main", `OAuth token loaded. len=${token.length} prefix=${token.slice(0, 15)}... suffix=...${token.slice(-10)}`)

    // Step 2: Create Ref and Semaphore (validation deferred to validateInContainer)
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

      validateInContainer: (containerId: string) =>
        Effect.gen(function* () {
          const { token: currentToken } = yield* Ref.get(tokenRef)
          yield* logToConsole("orchestrator", "main", "Validating OAuth token inside container...")
          const valid = validateTokenInContainer(currentToken, containerId)
          if (valid) {
            yield* logToConsole("orchestrator", "main", "Token validated successfully in container")
            return true
          }

          // Token failed — try refreshing and re-validating
          yield* logToConsole("orchestrator", "main", "Token invalid in container — refreshing...")
          const { status, stdout } = runSetupToken()
          if (status !== 0) {
            yield* logToConsole("orchestrator", "main", "Token refresh failed")
            return false
          }

          const newToken = extractTokenFromOutput(stdout)
          if (!newToken) {
            yield* logToConsole("orchestrator", "main", "Could not extract token after refresh")
            return false
          }

          saveToken(projectRoot, newToken)
          const current = yield* Ref.get(tokenRef)
          yield* Ref.set(tokenRef, { token: newToken, version: current.version + 1 })

          const retryValid = validateTokenInContainer(newToken, containerId)
          if (retryValid) {
            yield* logToConsole("orchestrator", "main", "Refreshed token validated in container")
          } else {
            yield* logToConsole("orchestrator", "main", "Refreshed token also failed in container")
          }
          return retryValid
        }),
    })
  }),
)
