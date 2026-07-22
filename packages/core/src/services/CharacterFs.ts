import { Context, Effect, Layer } from "effect"
import { FileSystem } from "@effect/platform"
import * as path from "node:path"
import { TEMPLATE_PALETTE } from "../core/palette.js"
import { TEMPLATE_SALIENCE } from "../core/salience.js"
import { TEMPLATE_DRIVES } from "#brain/limbic/hypothalamus/drives.js"
import {
  parseSkillFile,
  serializeSkillFile,
  slugify,
  validateSkillWrite,
  type SkillDoc,
  type SkillMeta,
} from "./skills-core.js"

/** The bounded memory-index doc macro rewrites and orient injects (spec §4 macro). */
export const SYNTHESIS_FILE = "SYNTHESIS.md"

export interface Credentials {
  username: string
  password: string
}

/**
 * Why a CharacterFs write failed. `"validation"` is a deterministic rejection —
 * the input violated a cap/shape rule (writeSkill's validateSkillWrite) and will
 * fail identically on every retry, so a caller should record it as a real
 * rejection. `"io"` (the default) is a transient/environmental filesystem
 * failure that a later cycle may succeed at, so a caller should NOT treat it as
 * a rejection — it should leave the work pending for retry. The macro
 * adjudication loop relies on this split (see hippocampus/macro.ts).
 */
export type CharacterFsErrorKind = "io" | "validation"

export class CharacterFsError {
  readonly _tag = "CharacterFsError"
  constructor(
    readonly message: string,
    readonly cause?: unknown,
    readonly kind: CharacterFsErrorKind = "io",
  ) {}
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
    readonly readPalette: (char: CharacterConfig) => Effect.Effect<string, CharacterFsError>
    readonly readDrives: (char: CharacterConfig) => Effect.Effect<string, CharacterFsError>
    readonly readSalience: (char: CharacterConfig) => Effect.Effect<string, CharacterFsError>
    readonly characterExists: (char: CharacterConfig) => Effect.Effect<boolean, CharacterFsError>
    readonly listSkills: (char: CharacterConfig) => Effect.Effect<SkillMeta[], CharacterFsError>
    readonly readSkill: (char: CharacterConfig, name: string) => Effect.Effect<SkillDoc | null, CharacterFsError>
    readonly writeSkill: (char: CharacterConfig, skill: SkillDoc) => Effect.Effect<void, CharacterFsError>
    readonly readSynthesis: (char: CharacterConfig) => Effect.Effect<string, CharacterFsError>
    readonly writeSynthesis: (char: CharacterConfig, content: string) => Effect.Effect<void, CharacterFsError>
    readonly deleteSkill: (char: CharacterConfig, name: string) => Effect.Effect<void, CharacterFsError>
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

      readPalette: (char) =>
        readFileOr(path.join(char.dir, "PALETTE.md"), TEMPLATE_PALETTE),

      readDrives: (char) =>
        readFileOr(path.join(char.dir, "DRIVES.md"), TEMPLATE_DRIVES),

      readSalience: (char) =>
        readFileOr(path.join(char.dir, "SALIENCE.md"), TEMPLATE_SALIENCE),

      characterExists: (char) =>
        fs.exists(char.dir).pipe(
          Effect.mapError((e) => new CharacterFsError("Failed to check character dir", e)),
        ),

      // ── Agent-maintained skills (spec §3) ──────────────────────
      // players/<name>/me/skills/<slug>.md. Reads never fail (missing dir/file
      // → []/null — the agent can delete files directly). writeSkill fails only
      // on a cap violation or genuine IO error.
      listSkills: (char) =>
        Effect.gen(function* () {
          const dir = path.join(char.dir, "skills")
          const exists = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false))
          if (!exists) return []
          const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as string[]))
          const metas: SkillMeta[] = []
          for (const entry of entries) {
            if (!entry.endsWith(".md")) continue
            const slug = entry.slice(0, -3)
            const text = yield* fs.readFileString(path.join(dir, entry)).pipe(Effect.orElseSucceed(() => ""))
            if (!text) continue
            const d = parseSkillFile(slug, text)
            metas.push({ slug: d.slug, name: d.name, description: d.description, whenToUse: d.whenToUse })
          }
          metas.sort((a, b) => a.slug.localeCompare(b.slug))
          return metas
        }),

      readSkill: (char, name) =>
        Effect.gen(function* () {
          const slug = slugify(name)
          const file = path.join(char.dir, "skills", `${slug}.md`)
          const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))
          if (!exists) return null
          const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
          return text ? parseSkillFile(slug, text) : null
        }),

      writeSkill: (char, skill) =>
        Effect.gen(function* () {
          const dir = path.join(char.dir, "skills")
          yield* fs.makeDirectory(dir, { recursive: true }).pipe(
            Effect.mapError((e) => new CharacterFsError("Failed to make skills dir", e)),
          )
          const slug = slugify(skill.name)
          const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as string[]))
          const slugs = entries.filter((e) => e.endsWith(".md")).map((e) => e.slice(0, -3))
          const check = validateSkillWrite(slugs, slug, skill.body, {
            name: skill.name,
            description: skill.description,
            whenToUse: skill.whenToUse,
          })
          // A cap/shape violation is a DETERMINISTIC rejection (kind:"validation")
          // — it fails identically on retry, so the caller records it as rejected.
          // The makeDirectory/writeFileString failures below stay kind:"io" (the
          // default): transient, so the caller leaves the write pending for retry.
          if (!check.ok) return yield* Effect.fail(new CharacterFsError(check.error, undefined, "validation"))
          yield* fs
            .writeFileString(path.join(dir, `${slug}.md`), serializeSkillFile({ ...skill, slug }))
            .pipe(Effect.mapError((e) => new CharacterFsError("Failed to write skill", e)))
        }),

      // ── Self-model synthesis (spec §4 macro) ───────────────────
      // me/SYNTHESIS.md — read like an identity file (missing → ""), written
      // only by the macro cycle (bounded there). Injected into orient.
      readSynthesis: (char) =>
        readFileOr(path.join(char.dir, SYNTHESIS_FILE), ""),

      writeSynthesis: (char, content) =>
        Effect.gen(function* () {
          // Unlike writeDiary/writeSecrets (identity files provisioned before
          // the cortex loop ever runs), me/ may not yet exist when the macro
          // cycle first fires — ensure it does, mirroring writeSkill's dir setup.
          yield* fs.makeDirectory(char.dir, { recursive: true }).pipe(
            Effect.mapError((e) => new CharacterFsError("Failed to make character dir", e)),
          )
          yield* fs.writeFileString(path.join(char.dir, SYNTHESIS_FILE), content).pipe(
            Effect.mapError((e) => new CharacterFsError("Failed to write synthesis", e)),
          )
        }),

      // The sanctioned macro retire path: remove me/skills/<slug>.md. A missing
      // file is a no-op (idempotent) — the agent may already have deleted it
      // directly. Only ever targets a file under me/skills/ (slug-derived).
      deleteSkill: (char, name) =>
        Effect.gen(function* () {
          const file = path.join(char.dir, "skills", `${slugify(name)}.md`)
          const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))
          if (!exists) return
          yield* fs.remove(file).pipe(
            Effect.mapError((e) => new CharacterFsError("Failed to delete skill", e)),
          )
        }),
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
