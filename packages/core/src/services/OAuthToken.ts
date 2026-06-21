import { Context, Effect, Layer, Ref } from "effect"
import { spawnSync } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import * as path from "node:path"

import { ProjectRoot } from "./ProjectRoot.js"
import { DockerError } from "./Docker.js"
import { loadSavedToken, TOKEN_FILENAME } from "./oauth-token.js"
import { logToConsole } from "../logging/log-writer.js"

/**
 * Outcome of validating a token inside a container. Crucially distinguishes a
 * genuine auth rejection from the container simply not being available (e.g. it
 * exited because the firewall init script died), so callers surface a truthful
 * error instead of always blaming the OAuth token.
 */
export type ValidationOutcome =
  | { readonly kind: "valid" }
  | { readonly kind: "rate-limited"; readonly detail: string }
  | { readonly kind: "auth-rejected"; readonly detail: string }
  | { readonly kind: "container-unavailable"; readonly detail: string }

export class OAuthToken extends Context.Tag("OAuthToken")<
  OAuthToken,
  {
    /** Read the current token from the Ref. Returns { token, version }. */
    readonly getToken: Effect.Effect<{ token: string; version: number }>
    /** Validate the token by running a ping inside a Docker container. Returns true if valid. */
    readonly validateInContainer: (containerId: string) => Effect.Effect<boolean>
    /**
     * Like {@link validateInContainer} but returns a classified outcome so the
     * caller can tell "auth rejected" apart from "container not running".
     *
     * Optional so existing lightweight stubs (which only implement the boolean
     * `validateInContainer`) still satisfy the interface; the live layer always
     * provides it and callers should prefer it.
     */
    readonly checkInContainer?: (containerId: string) => Effect.Effect<ValidationOutcome>
  }
>() {}

interface ExecResult {
  readonly ok: boolean
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

/**
 * Classify a `docker exec … claude -p ping` result into a {@link ValidationOutcome}.
 *
 * The key correctness property (Bug A): a container that died (firewall init
 * script exited under `set -euo pipefail`, so `&& sleep infinity` never ran)
 * makes `docker exec` fail with exit 137 (SIGKILL) or a "not running" / "no such
 * container" error. That is NOT an auth failure — the token may be perfectly
 * valid. We only call it `auth-rejected` when the exec actually ran inside a
 * live container and `claude` rejected the credentials.
 *
 * Pure and exported for unit testing.
 */
export function classifyValidationResult(
  result: ExecResult,
  ctx: { readonly containerRunning: boolean },
): ValidationOutcome {
  if (result.ok) {
    return { kind: "valid" }
  }

  const combined = `${result.stdout} ${result.stderr}`.toLowerCase()

  // A rate-limit response means auth succeeded — token is valid, just throttled.
  if (/hit your limit|rate limit|usage limit|resets/.test(combined)) {
    return { kind: "rate-limited", detail: result.stdout.trim().slice(0, 200) }
  }

  // Container-unavailable signals, in order of reliability:
  //  - the container isn't actually running (authoritative)
  //  - docker reported it couldn't exec (no such container / not running)
  //  - the process was killed by a signal (status > 128, e.g. 137 = 128+SIGKILL)
  //  - exec never produced a status (failed to launch)
  const dockerSaysGone =
    /is not running|no such container|cannot exec|is not paused|container .* not/.test(combined)
  const killedBySignal = typeof result.status === "number" && result.status > 128
  const neverLaunched = result.status === null
  if (!ctx.containerRunning || dockerSaysGone || killedBySignal || neverLaunched) {
    const detail =
      `container not available (running=${ctx.containerRunning}, exit=${result.status}) ` +
      `${result.stderr.trim().slice(0, 200)}`.trim()
    return { kind: "container-unavailable", detail }
  }

  return {
    kind: "auth-rejected",
    detail: `exit=${result.status} ${result.stderr.trim().slice(0, 300)}`.trim(),
  }
}

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

/**
 * Return true if `docker inspect` reports the container as currently running.
 * Returns false on any error (container gone, docker unavailable, etc.).
 */
function isContainerRunning(containerId: string): boolean {
  const result = spawnSync(
    "docker",
    ["inspect", "-f", "{{.State.Running}}", containerId],
    { encoding: "utf-8", timeout: 10000 },
  )
  return result.status === 0 && (result.stdout ?? "").trim() === "true"
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

    const checkInContainer = (containerId: string) =>
      Effect.gen(function* () {
        const { token: currentToken } = yield* Ref.get(tokenRef)
        yield* Effect.logInfo(
          `Validating OAuth token inside container ${containerId.slice(0, 12)} (token len=${currentToken.length})...`,
        )
        const result = validateTokenInContainer(currentToken, containerId)
        // If the exec failed, ask docker authoritatively whether the container
        // is even running — this is what lets us distinguish "auth rejected"
        // from "container died" (Bug A).
        const containerRunning = result.ok ? true : isContainerRunning(containerId)
        const outcome = classifyValidationResult(result, { containerRunning })

        switch (outcome.kind) {
          case "valid":
            yield* Effect.logInfo("Token validated in container")
            break
          case "rate-limited":
            yield* Effect.logInfo(`Token is valid but rate-limited: ${outcome.detail}`)
            break
          case "container-unavailable":
            yield* Effect.logWarning(
              `Container is not available for token validation (not an auth failure): ${outcome.detail}`,
            )
            break
          case "auth-rejected":
            yield* Effect.logWarning(`Token validation failed: ${outcome.detail}`)
            yield* Effect.logWarning(
              "Token is invalid inside container. Run 'claude setup-token' and update .oauth-token",
            )
            break
        }
        return outcome
      })

    return OAuthToken.of({
      getToken: Ref.get(tokenRef),
      checkInContainer,
      validateInContainer: (containerId: string) =>
        checkInContainer(containerId).pipe(
          Effect.map((o) => o.kind === "valid" || o.kind === "rate-limited"),
        ),
    })
  }),
)
