import * as path from "node:path"
import { readFileSync, existsSync } from "node:fs"

/**
 * SpaceMolt session-file foundation (Phase 0).
 *
 * Auth source of truth is per-player `.spacemolt-session.json` — the client-v2
 * CLI's native multi-account session file (`MultiSessionFile`, version 2) —
 * replacing the legacy `credentials.txt`.
 *
 * Path convention
 * ---------------
 *   host:      <projectRoot>/players/<name>/me/.spacemolt-session.json
 *   container: /work/players/<name>/me/.spacemolt-session.json
 *
 * The `players/` tree is mounted to `/work/players` (see config.ts
 * `containerMounts`), so the same file is visible on both sides. The container
 * CLI's `SPACEMOLT_SESSION` env should point at the container path; the host
 * library (`createSocket` / `createSession`) reads the same file via the host
 * path to recover `{ username, password }`. The session file lives in the `me/`
 * subdirectory alongside the rest of a character's per-player files, matching
 * `InitContext.characterDir`.
 *
 * The REST `X-Session-Id` token and the WS auth are independent (one account
 * holds both at once), so the CLI (Team A, REST/actions) and the library
 * (Team B, WebSocket/events) can both use this one file without conflict.
 */

/** Base URL the client-v2 CLI targets (includes the `/api/v2` REST path). */
export const SPACEMOLT_URL_DEFAULT = "https://game.spacemolt.com/api/v2"

/** Default basename client-v2 uses for its session file. */
export const SESSION_FILE_NAME = ".spacemolt-session.json"

/** Per-player subdirectory under `players/<name>/` (mirrors `characterDir`). */
const PLAYER_SUBDIR = "me"

/** Container path that `players/` is mounted to (see config.ts mounts). */
const CONTAINER_PLAYERS_ROOT = "/work/players"

/**
 * CLI base URL: `SPACEMOLT_URL` env override, else the default.
 * Consumed by Team A (CLI provisioning) and Team B (library) so both target
 * the same server.
 */
export const spaceMoltUrl = (): string => process.env.SPACEMOLT_URL ?? SPACEMOLT_URL_DEFAULT

/**
 * Origin (scheme + host) for the client-v2 library's `baseUrl` option.
 * `createSocket`/`createSession` want the API origin (e.g.
 * `https://game.spacemolt.com`) and append their own paths, so strip the
 * `/api/v2` segment from `spaceMoltUrl()`.
 */
export const spaceMoltSocketBaseUrl = (): string => {
  const u = new URL(spaceMoltUrl())
  return `${u.protocol}//${u.host}`
}

/**
 * Client identifier we send as the WebSocket handshake `User-Agent`, marking the
 * connection as roci. client-v2 (>=1.6.0) prepends this to its own token, so the
 * server sees e.g. `roci @spacemolt/client-v2/1.6.0`. Override with
 * `SPACEMOLT_USER_AGENT` (e.g. to pin a roci version like `roci/0.1.0`).
 */
export const spaceMoltUserAgent = (): string => process.env.SPACEMOLT_USER_AGENT ?? "roci"

/** Host path to a player's session file. */
export const sessionFilePath = (projectRoot: string, playerName: string): string =>
  path.resolve(projectRoot, "players", playerName, PLAYER_SUBDIR, SESSION_FILE_NAME)

/** Container path to a player's session file (for `SPACEMOLT_SESSION`). */
export const containerSessionPath = (playerName: string): string =>
  `${CONTAINER_PLAYERS_ROOT}/${playerName}/${PLAYER_SUBDIR}/${SESSION_FILE_NAME}`

/** Credentials the host library needs for `createSocket({ auth })`. */
export interface PlayerCredentials {
  readonly username: string
  readonly password: string
}

/** Shape of a client-v2 account entry within the session file. */
interface AccountData {
  username?: string
  password?: string
}

/** Shape of the client-v2 v2 session file. */
interface MultiSessionFile {
  version?: number
  activeAccount?: string | null
  accounts?: Record<string, AccountData>
}

/** Result of a non-throwing session-file shape check (used by `spacemolt-init`). */
export type SessionFileCheck =
  | { readonly ok: true; readonly username: string }
  | { readonly ok: false; readonly reason: string }

/** Pick the relevant account: the active one, else the sole account. */
const selectAccount = (file: MultiSessionFile): AccountData | undefined => {
  const accounts = file.accounts ?? {}
  const keys = Object.keys(accounts)
  if (file.activeAccount && accounts[file.activeAccount]) return accounts[file.activeAccount]
  if (keys.length === 1) return accounts[keys[0]]
  if (file.activeAccount) return undefined
  return keys.length > 0 ? accounts[keys[0]] : undefined
}

/**
 * Validate a session file's shape without throwing. Confirms it is the
 * client-v2 version-2 multi-account format and exposes a usable
 * username/password. Intended for the `spacemolt-init` health check.
 */
export const validateSessionFile = (filePath: string): SessionFileCheck => {
  if (!existsSync(filePath)) return { ok: false, reason: "session file not found" }

  let parsed: MultiSessionFile
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf-8")) as MultiSessionFile
  } catch (e) {
    return { ok: false, reason: `session file is not valid JSON (${e instanceof Error ? e.message : String(e)})` }
  }

  if (parsed.version !== 2) {
    return { ok: false, reason: `unexpected session file version (want 2, got ${String(parsed.version)})` }
  }

  const account = selectAccount(parsed)
  if (!account) {
    return { ok: false, reason: "no resolvable account (set activeAccount or store a single account)" }
  }
  if (!account.username) return { ok: false, reason: "account missing username" }
  if (!account.password) return { ok: false, reason: "account missing password" }

  return { ok: true, username: account.username }
}

export class SessionFileError extends Error {
  readonly _tag = "SessionFileError"
}

/**
 * Read a player's `{ username, password }` from their session file, for use
 * with the host library's `createSocket`/`createSession`. Throws
 * `SessionFileError` if the file is missing or malformed.
 */
export const readPlayerCredentials = (projectRoot: string, playerName: string): PlayerCredentials => {
  const filePath = sessionFilePath(projectRoot, playerName)
  const check = validateSessionFile(filePath)
  if (!check.ok) {
    throw new SessionFileError(`Cannot read credentials for "${playerName}" from ${filePath}: ${check.reason}`)
  }

  // Re-read to extract the password (validateSessionFile only surfaces username).
  const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as MultiSessionFile
  const account = selectAccount(parsed)!
  return { username: account.username!, password: account.password! }
}
