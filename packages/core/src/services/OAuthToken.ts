import { Context, Effect, Layer, Ref } from "effect"
import { readFileSync, writeFileSync, renameSync } from "node:fs"
import { homedir } from "node:os"
import * as path from "node:path"

import { DockerError } from "./Docker.js"
import { logToConsole } from "../logging/console-renderer.js"

// Credential file paths
const WSL_CREDS = path.join(homedir(), ".claude", ".credentials.json")
const WIN_CREDS = "/mnt/c/Users/Roy D. Lewis Jr/.claude/.credentials.json"
// Keep .oauth-token files in sync for Docker/process-runner consumers
const OAUTH_TOKEN_FILES = [
  "/home/savolent/Signal/.oauth-token",
  "/home/savolent/Signal/apps/.oauth-token",
]

export class OAuthToken extends Context.Tag("OAuthToken")<
  OAuthToken,
  {
    /**
     * Read the current token — always reads live from credentials.json.
     * Watchdog keeps that file fresh; no stale in-memory token possible.
     */
    readonly getToken: Effect.Effect<{ token: string; version: number }>
    /**
     * Refresh: sync Windows -> WSL credentials silently.
     * Does NOT call `claude setup-token` (no browser popup).
     */
    readonly refreshToken: (staleVersion: number) => Effect.Effect<string, DockerError>
  }
>() {}

interface CredsFile {
  claudeAiOauth?: { accessToken?: string; expiresAt?: number }
}

function readCreds(filePath: string): CredsFile | undefined {
  try { return JSON.parse(readFileSync(filePath, "utf-8")) as CredsFile }
  catch { return undefined }
}

/**
 * Return the best available access token.
 * Prefers WSL creds with > 10min remaining; falls back to Windows.
 */
function getLiveToken(): string | undefined {
  const nowMs = Date.now()
  const wsl = readCreds(WSL_CREDS)
  const wslExpiry = wsl?.claudeAiOauth?.expiresAt ?? 0

  if (wsl?.claudeAiOauth?.accessToken && wslExpiry - nowMs > 10 * 60 * 1000) {
    return wsl.claudeAiOauth.accessToken
  }

  // WSL stale — try Windows
  const win = readCreds(WIN_CREDS)
  const winExpiry = win?.claudeAiOauth?.expiresAt ?? 0
  if (win?.claudeAiOauth?.accessToken && winExpiry > nowMs) {
    return win.claudeAiOauth.accessToken
  }

  // Both stale — return WSL as last resort
  return wsl?.claudeAiOauth?.accessToken
}

/**
 * Copy Windows credentials -> WSL atomically + update .oauth-token files.
 * Returns the fresh token, or undefined if Windows is inaccessible/expired.
 */
function syncFromWindows(): string | undefined {
  try {
    const winContent = readFileSync(WIN_CREDS, "utf-8")
    const win = JSON.parse(winContent) as CredsFile
    if ((win?.claudeAiOauth?.expiresAt ?? 0) > Date.now()) {
      const tmp = WSL_CREDS + ".tmp"
      writeFileSync(tmp, winContent)
      renameSync(tmp, WSL_CREDS)
      const token = win.claudeAiOauth?.accessToken
      if (token) {
        for (const p of OAUTH_TOKEN_FILES) {
          try { writeFileSync(p, token + "\n") } catch { /* best effort */ }
        }
      }
      return token
    }
  } catch { /* Windows path not accessible */ }
  return undefined
}

export const OAuthTokenLive = Layer.effect(
  OAuthToken,
  Effect.gen(function* () {
    // Version counter for refresh coordination — not tied to token content
    const versionRef = yield* Ref.make(0)
    const semaphore = yield* Effect.makeSemaphore(1)

    // Log startup state
    const startToken = getLiveToken()
    yield* logToConsole(
      "orchestrator",
      "main",
      startToken
        ? `OAuthToken: live-creds mode. prefix=${startToken.slice(0, 15)}... (reads credentials.json per-call)`
        : "OAuthToken: WARNING -- no token in credentials.json at startup",
    )

    return OAuthToken.of({
      // Always reads fresh from file — watchdog keeps credentials.json current
      getToken: Effect.gen(function* () {
        const token = getLiveToken()
        if (!token) return yield* Effect.fail(new Error("No OAuth token in credentials.json") as never)
        const version = yield* Ref.get(versionRef)
        return { token, version }
      }),

      // Sync from Windows instead of opening a browser
      refreshToken: (staleVersion: number) =>
        semaphore.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(versionRef)
            // Another fiber already refreshed
            if (current !== staleVersion) return getLiveToken() ?? ""

            yield* logToConsole("orchestrator", "main", "OAuthToken: refreshing -- syncing Windows -> WSL...")
            const token = syncFromWindows() ?? getLiveToken()

            if (!token) {
              return yield* Effect.fail(
                new DockerError("Cannot refresh OAuth token: no valid credentials in Windows or WSL"),
              )
            }

            yield* Ref.update(versionRef, (v) => v + 1)
            yield* logToConsole("orchestrator", "main", "OAuthToken: refreshed successfully")
            return token
          }),
        ),
    })
  }),
)
