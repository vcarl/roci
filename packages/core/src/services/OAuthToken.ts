import { Context, Effect, Layer, Ref } from "effect"
import { spawnSync } from "node:child_process"

import { ProjectRoot } from "./ProjectRoot.js"
import { DockerError } from "./Docker.js"
import { loadSavedToken } from "./oauth-token.js"
import { logToConsole } from "../logging/console-renderer.js"

export class OAuthToken extends Context.Tag("OAuthToken")<
  OAuthToken,
  {
    /** Read the current token from the Ref. Returns { token, version }. */
    readonly getToken: Effect.Effect<{ token: string; version: number }>
    /** Validate the token by running a ping inside a Docker container. Returns true if valid. */
    readonly validateInContainer: (containerId: string) => Effect.Effect<boolean>
  }
>() {}

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

    const token = loadSavedToken(projectRoot)
    if (!token) {
      return yield* Effect.fail(
        new DockerError(
          "No OAuth token found. Run 'claude setup-token' and save the output to .oauth-token in your project root.",
        ),
      )
    }
    yield* logToConsole("orchestrator", "main", `OAuth token loaded. len=${token.length} prefix=${token.slice(0, 15)}... suffix=...${token.slice(-10)}`)

    const tokenRef = yield* Ref.make({ token, version: 0 })

    return OAuthToken.of({
      getToken: Ref.get(tokenRef),

      validateInContainer: (containerId: string) =>
        Effect.gen(function* () {
          const { token: currentToken } = yield* Ref.get(tokenRef)
          yield* logToConsole("orchestrator", "main", "Validating OAuth token inside container...")
          const valid = validateTokenInContainer(currentToken, containerId)
          if (valid) {
            yield* logToConsole("orchestrator", "main", "Token validated in container")
            return true
          }
          yield* logToConsole("orchestrator", "main", "Token is invalid inside container. Run 'claude setup-token' and update .oauth-token")
          return false
        }),
    })
  }),
)
