import { Effect } from "effect"
import * as path from "node:path"
import { mkdirSync, writeFileSync } from "node:fs"
import { createClient, spacemoltAuthRegister } from "@spacemolt/client-v2"
import type { CharacterConfig } from "@roci/core/services/CharacterFs.js"
import { sessionFilePath, spaceMoltSocketBaseUrl } from "./session.js"

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
 * Register a new SpaceMolt character via the client-v2 REST API and persist the
 * returned credentials to the per-player session file (the client-v2
 * `MultiSessionFile`, version 2). On success the account is immediately usable
 * by both the host library (`createSocket`) and the container CLI.
 */
export function registerCharacter(
  char: CharacterConfig,
  registrationCode: string,
): Effect.Effect<RegistrationResult, RegistrationError> {
  return Effect.gen(function* () {
    const username = deriveUsername(char.name)
    const empire = pickEmpire(char.name)

    const client = createClient({ baseUrl: spaceMoltSocketBaseUrl() })

    const res = yield* Effect.tryPromise({
      try: () =>
        spacemoltAuthRegister({
          client,
          body: { username, empire, registration_code: registrationCode },
        }),
      catch: (e) => new RegistrationError("Registration request failed", e),
    })

    if (res.error) {
      const err = res.error as { code?: string; message?: string }
      const detail = err.code || err.message
        ? `${err.code ?? "error"} — ${err.message ?? "unknown error"}`
        : JSON.stringify(res.error)
      return yield* Effect.fail(new RegistrationError(`Registration failed: ${detail}`))
    }

    const password = res.data?.structuredContent?.password
    if (!password) {
      return yield* Effect.fail(
        new RegistrationError("Registration succeeded but no password was returned"),
      )
    }
    const playerId = res.data?.structuredContent?.player?.id ?? ""

    // Persist credentials as the client-v2 v2 multi-account session file so
    // readPlayerCredentials / validateSessionFile can recover them later.
    const projectRoot = path.resolve(char.root, "..", "..")
    const filePath = sessionFilePath(projectRoot, char.name)
    const sessionContent = JSON.stringify(
      {
        version: 2,
        activeAccount: username,
        accounts: { [username]: { username, password } },
      },
      null,
      2,
    )

    yield* Effect.try({
      try: () => {
        mkdirSync(path.dirname(filePath), { recursive: true })
        writeFileSync(filePath, sessionContent + "\n", "utf-8")
      },
      catch: (e) => new RegistrationError(`Failed to write session file ${filePath}`, e),
    })

    return { username, password, playerId }
  })
}
