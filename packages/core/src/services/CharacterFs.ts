import { Context, Effect, Layer } from "effect"
import { FileSystem } from "@effect/platform"
import * as path from "node:path"

export interface Credentials {
  username: string
  password: string
}

export class CharacterFsError {
  readonly _tag = "CharacterFsError"
  constructor(readonly message: string, readonly cause?: unknown) {}
  toString() { return this.message }
}

export interface CharacterConfig {
  name: string
  dir: string // absolute path to players/<name>/me/
}

export class CharacterFs extends Context.Tag("CharacterFs")<
  CharacterFs,
  {
    readonly readDiary: (char: CharacterConfig) => Effect.Effect<string, CharacterFsError>
    readonly writeDiary: (char: CharacterConfig, content: string) => Effect.Effect<void, CharacterFsError>
    readonly readSecrets: (char: CharacterConfig) => Effect.Effect<string, CharacterFsError>
    readonly writeSecrets: (char: CharacterConfig, content: string) => Effect.Effect<void, CharacterFsError>
    readonly readCredentials: (char: CharacterConfig) => Effect.Effect<Credentials, CharacterFsError>
    readonly readBackground: (char: CharacterConfig) => Effect.Effect<string, CharacterFsError>
    readonly readValues: (char: CharacterConfig) => Effect.Effect<string, CharacterFsError>
    readonly characterExists: (char: CharacterConfig) => Effect.Effect<boolean, CharacterFsError>
  }
>() {}

function parseCredentialsFile(content: string): Credentials | null {
  let username = ""
  let password = ""
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.startsWith("#") || !trimmed) continue
    const uMatch = trimmed.match(/^Username:\s*(.+)/)
    if (uMatch) username = uMatch[1].trim()
    const pMatch = trimmed.match(/^Password:\s*(.+)/)
    if (pMatch) password = pMatch[1].trim()
  }
  if (username && password) return { username, password }
  return null
}

export const CharacterFsLive = Layer.effect(
  CharacterFs,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const readFileOr = (filePath: string, fallback: string) =>
      fs.readFileString(filePath).pipe(
        Effect.catchAll(() => Effect.succeed(fallback)),
        Effect.mapError((e) => new CharacterFsError(`Failed to read ${filePath}`, e)),
      )

    return CharacterFs.of({
      readDiary: (char) =>
        readFileOr(path.join(char.dir, "DIARY.md"), ""),

      writeDiary: (char, content) =>
        fs.writeFileString(path.join(char.dir, "DIARY.md"), content).pipe(
          Effect.mapError((e) => new CharacterFsError("Failed to write diary", e)),
        ),

      readSecrets: (char) =>
        readFileOr(path.join(char.dir, "SECRETS.md"), ""),

      writeSecrets: (char, content) =>
        fs.writeFileString(path.join(char.dir, "SECRETS.md"), content).pipe(
          Effect.mapError((e) => new CharacterFsError("Failed to write secrets", e)),
        ),

      readCredentials: (char) =>
        Effect.gen(function* () {
          const content = yield* fs.readFileString(path.join(char.dir, "credentials.txt")).pipe(
            Effect.mapError((e) => new CharacterFsError("Failed to read credentials", e)),
          )
          const creds = parseCredentialsFile(content)
          if (!creds) {
            return yield* Effect.fail(
              new CharacterFsError(`Invalid credentials file for ${char.name}`),
            )
          }
          return creds
        }),

      readBackground: (char) =>
        readFileOr(path.join(char.dir, "background.md"), ""),

      readValues: (char) =>
        readFileOr(path.join(char.dir, "VALUES.md"), ""),

      characterExists: (char) =>
        fs.exists(char.dir).pipe(
          Effect.mapError((e) => new CharacterFsError("Failed to check character dir", e)),
        ),
    })
  }),
)

export function makeCharacterConfig(
  projectRoot: string,
  characterName: string,
): CharacterConfig {
  return {
    name: characterName,
    dir: path.resolve(projectRoot, "players", characterName, "me"),
  }
}
