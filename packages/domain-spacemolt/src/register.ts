import { Effect } from "effect"
import * as path from "node:path"
import { mkdirSync, writeFileSync } from "node:fs"
import { Account } from "@spacemolt/lib"
import type { CharacterConfig } from "@roci/core/services/CharacterFs.js"
import { sessionFilePath, spaceMoltWsUrl } from "./session.js"

const EMPIRES = ["solarian", "crimson", "nebula", "voidborn", "outerrim"] as const

type Empire = (typeof EMPIRES)[number]

export class RegistrationError {
  readonly _tag = "RegistrationError"
  constructor(readonly message: string, readonly cause?: unknown) {}
  toString() { return this.message }
}

export interface RegistrationResult {
  readonly username: string
  readonly password: string
  readonly playerId: string
}

/**
 * Derive a SpaceMolt username from a character name.
 * Lowercase, replace spaces/hyphens with underscores, strip non-alphanumeric/underscore chars, truncate to 24.
 */
export function deriveUsername(characterName: string): string {
  return characterName
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 24)
}

/**
 * Pick an empire deterministically from the character name.
 * Uses a simple hash so the same character always gets the same empire.
 */
export function pickEmpire(characterName: string): Empire {
  let hash = 0
  for (let i = 0; i < characterName.length; i++) {
    hash = ((hash << 5) - hash + characterName.charCodeAt(i)) | 0
  }
  return EMPIRES[Math.abs(hash) % EMPIRES.length]
}

/**
 * The exact bytes of a client-v2 v2 `MultiSessionFile`.
 *
 * PURE and exported so the format is testable without registering a real
 * account — the one thing this module does that cannot be exercised against the
 * live server, because registration is a mutation.
 *
 * The format belongs to the REST `spacemolt` CLI, which rewrites this file on
 * every re-auth. roci WRITES it exactly once, here, at character creation, and
 * only ever READS it afterwards (`readPlayerCredentials`). `version: 2` is not
 * negotiable: `validateSessionFile` rejects anything else, and so does the CLI.
 */
export function sessionFileContent(username: string, password: string): string {
  return (
    JSON.stringify(
      { version: 2, activeAccount: username, accounts: { [username]: { username, password } } },
      null,
      2,
    ) + "\n"
  )
}

/**
 * Register a new SpaceMolt character and persist the returned credentials to the
 * per-player session file (the client-v2 `MultiSessionFile`, version 2). On
 * success the account is immediately usable by BOTH the host socket
 * (`readPlayerCredentials` → `Account.authenticate`) and the container's REST
 * `spacemolt` CLI, which reads the same file.
 *
 * Ported from `@spacemolt/client-v2`'s REST `spacemoltAuthRegister` to
 * `@spacemolt/lib`'s `Account.register` (`account.ts:424`) — the same underlying
 * auth primitive, returning the same 256-bit hex credential, over the socket
 * that is now the domain's only transport. This port is what lets the
 * client-v2 dependency be severed; it was its last non-test consumer.
 *
 * The `Account` opened here is SHORT-LIVED and deliberately separate from the
 * one `GameSocket.connect` opens: it exists only to complete registration, is
 * closed immediately, and carries no reconnect config. `phases.ts` re-enters
 * the normal connect path afterwards, which reads the file this just wrote.
 */
export function registerCharacter(
  char: CharacterConfig,
  registrationCode: string,
): Effect.Effect<RegistrationResult, RegistrationError> {
  return Effect.gen(function* () {
    const username = deriveUsername(char.name)
    const empire = pickEmpire(char.name)

    const account = new Account({ url: spaceMoltWsUrl() })

    const result = yield* Effect.tryPromise({
      try: async () => {
        await account.connect()
        return await account.register({ username, empire, registration_code: registrationCode })
      },
      catch: (e) => new RegistrationError(`Registration failed: ${String(e)}`, e),
    }).pipe(
      // Always release the socket, success or failure — a leaked registration
      // connection holds this account's server-side slot and the very next
      // login would be answered with a session_replaced close (4001).
      Effect.ensuring(
        Effect.try({ try: () => account.close(), catch: (e) => e }).pipe(Effect.catchAll(() => Effect.void)),
      ),
    )

    if (!result.password) {
      return yield* Effect.fail(
        new RegistrationError("Registration succeeded but no password was returned"),
      )
    }
    const password = result.password
    const playerId = result.player_id ?? ""

    // Persist credentials as the client-v2 v2 multi-account session file so
    // readPlayerCredentials / validateSessionFile can recover them later.
    const projectRoot = path.resolve(char.root, "..", "..")
    const filePath = sessionFilePath(projectRoot, char.name)
    const sessionContent = sessionFileContent(username, password)

    yield* Effect.try({
      try: () => {
        mkdirSync(path.dirname(filePath), { recursive: true })
        writeFileSync(filePath, sessionContent, "utf-8")
      },
      catch: (e) => new RegistrationError(`Failed to write session file ${filePath}`, e),
    })

    return { username, password, playerId }
  })
}
