import { Context, Effect, Layer, Ref } from "effect"
import { spawnSync } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import * as path from "node:path"

import { ProjectRoot } from "./ProjectRoot.js"
import { DockerError } from "./Docker.js"
import { loadSavedToken, TOKEN_FILENAME } from "./oauth-token.js"
import { logToConsole } from "../logging/log-writer.js"

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
function validateTokenInContainer(
  token: string,
  containerId: string,
): { ok: boolean; status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-e", `CLAUDE_CODE_OAUTH_TOKEN=${token}`,
      containerId,
      "claude", "-p", "--permission-mode", "bypassPermissions",
      "--model", "haiku",
      "--output-format", "text", "ping",
    ],
    {
      encoding: "utf-8",
      timeout: 30000,
    },
  )
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
}

export const OAuthTokenLive = Layer.effect(
  OAuthToken,
  Effect.gen(function* () {
    const projectRoot = yield* ProjectRoot
    const tokenPath = path.resolve(projectRoot, TOKEN_FILENAME)
    const tokenExists = existsSync(tokenPath)
    yield* logToConsole(
      "orchestrator",
      "main",
      `Env: cwd=${process.cwd()} projectRoot=${projectRoot} tokenPath=${tokenPath} exists=${tokenExists}` +
        (tokenExists ? ` size=${statSync(tokenPath).size}` : ""),
    )

    const token = loadSavedToken(projectRoot)
    if (!token) {
      return yield* Effect.fail(
        new DockerError(
          `No OAuth token found at ${tokenPath}. Run 'claude setup-token' and save the output to .oauth-token in your project root.`,
        ),
      )
    }
    yield* logToConsole(
      "orchestrator",
      "main",
      `OAuth token loaded. len=${token.length} prefix=${token.slice(0, 15)}... suffix=...${token.slice(-10)} hasWhitespace=${/\s/.test(token)}`,
    )

    const tokenRef = yield* Ref.make({ token, version: 0 })

    return OAuthToken.of({
      getToken: Ref.get(tokenRef),

      validateInContainer: (containerId: string) =>
        Effect.gen(function* () {
          const { token: currentToken } = yield* Ref.get(tokenRef)
          yield* logToConsole(
            "orchestrator",
            "main",
            `Validating OAuth token inside container ${containerId.slice(0, 12)} (token len=${currentToken.length})...`,
          )
          const result = validateTokenInContainer(currentToken, containerId)
          if (result.ok) {
            yield* logToConsole("orchestrator", "main", "Token validated in container")
            return true
          }
          // A rate-limit response means auth succeeded — token is valid, just throttled.
          const combined = `${result.stdout} ${result.stderr}`.toLowerCase()
          if (/hit your limit|rate limit|usage limit|resets/.test(combined)) {
            yield* logToConsole(
              "orchestrator",
              "main",
              `Token is valid but rate-limited: ${result.stdout.trim().slice(0, 200)}`,
            )
            return true
          }
          yield* logToConsole(
            "orchestrator",
            "main",
            `Token validation failed: exit=${result.status} stderr=${result.stderr.trim().slice(0, 500)} stdout=${result.stdout.trim().slice(0, 500)}`,
          )
          yield* logToConsole(
            "orchestrator",
            "main",
            "Token is invalid inside container. Run 'claude setup-token' and update .oauth-token",
          )
          return false
        }),
    })
  }),
)
