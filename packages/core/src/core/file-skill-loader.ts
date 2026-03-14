import { Effect } from "effect"
import { FileSystem } from "@effect/platform"
import { loadTemplateWithMeta } from "./template.js"

export interface LoadedSkill {
  readonly name: string
  readonly description: string
  readonly instructions: string
  readonly model: "haiku" | "sonnet"
  readonly allowedTools: string[]
}

export interface LoadedProcedure {
  readonly name: string
  readonly description: string
  readonly template: string
}

/**
 * Load skills from a directory of subdirectories, each containing a SKILL.md.
 * e.g. skills/investigate/SKILL.md, skills/code/SKILL.md
 */
export const loadSkillsFromDir = (dirPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const entries = yield* fs.readDirectory(dirPath)
    const skills = new Map<string, LoadedSkill>()

    for (const entry of entries) {
      const skillPath = `${dirPath}/${entry}/SKILL.md`
      const exists = yield* fs.exists(skillPath)
      if (!exists) continue

      const { meta, body } = yield* loadTemplateWithMeta(skillPath)
      const name = (meta.name as string) ?? entry
      skills.set(name, {
        name,
        description: (meta.description as string) ?? "",
        instructions: body,
        model: (meta.model as "haiku" | "sonnet") ?? "haiku",
        allowedTools: Array.isArray(meta["allowed-tools"])
          ? meta["allowed-tools"] as string[]
          : typeof meta["allowed-tools"] === "string"
            ? [meta["allowed-tools"] as string]
            : [],
      })
    }

    return skills
  })

/**
 * Load procedure templates from a directory of .md files.
 * e.g. procedures/select.md, procedures/triage.md
 */
export const loadProceduresFromDir = (dirPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const entries = yield* fs.readDirectory(dirPath)
    const procedures = new Map<string, LoadedProcedure>()

    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue
      const procPath = `${dirPath}/${entry}`

      const { meta, body } = yield* loadTemplateWithMeta(procPath)
      const name = (meta.name as string) ?? entry.replace(/\.md$/, "")
      procedures.set(name, {
        name,
        description: (meta.description as string) ?? "",
        template: body,
      })
    }

    return procedures
  })
