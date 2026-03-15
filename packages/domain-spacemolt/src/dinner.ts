import * as path from "node:path"
import { Effect } from "effect"
import { FileSystem } from "@effect/platform"
import { Claude } from "@signal/core/services/Claude.js"
import { CharacterFs, type CharacterConfig } from "@signal/core/services/CharacterFs.js"
import { CharacterLog } from "@signal/core/logging/log-writer.js"
import { ProjectRoot } from "@signal/core/services/ProjectRoot.js"
import { renderTemplate, loadTemplate } from "@signal/core/core/template.js"

export interface DinnerInput {
  char: CharacterConfig
}

export interface DinnerOutput {
  diaryUpdated: boolean
}

const PROMPTS_DIR = path.resolve(import.meta.dirname, "prompts")

export const dinner = {
  name: "dinner" as const,
  execute: (input: DinnerInput) =>
    Effect.gen(function* () {
      const claude = yield* Claude
      const charFs = yield* CharacterFs
      const log = yield* CharacterLog
      const fs = yield* FileSystem.FileSystem
      const projectRoot = yield* ProjectRoot

      yield* log.thought(input.char, {
        timestamp: new Date().toISOString(),
        source: "dinner",
        character: input.char.name,
        type: "dinner_start",
      })

      // Read recent thoughts log as session report
      const thoughtsPath = path.resolve(
        projectRoot,
        "players",
        input.char.name,
        "logs",
        "thoughts.jsonl",
      )
      const thoughtsRaw = yield* fs.readFileString(thoughtsPath).pipe(
        Effect.catchAll(() => Effect.succeed("")),
      )
      // Take last ~500 lines
      const thoughtLines = thoughtsRaw.split("\n")
      const sessionReport = thoughtLines.slice(-500).join("\n")

      const diary = yield* charFs.readDiary(input.char)
      const values = yield* charFs.readValues(input.char)

      const dinnerTemplate = yield* loadTemplate(path.join(PROMPTS_DIR, "dinner.md"))

      const prompt = renderTemplate(dinnerTemplate, {
        SESSION_REPORT: sessionReport,
        DIARY: diary,
        VALUES: values,
      })

      const updatedDiary = yield* claude.invoke({
        prompt,
        model: "haiku",
        outputFormat: "text",
        maxTurns: 1,
      })

      yield* charFs.writeDiary(input.char, updatedDiary)

      yield* log.thought(input.char, {
        timestamp: new Date().toISOString(),
        source: "dinner",
        character: input.char.name,
        type: "dinner_complete",
        diaryUpdated: true,
      })

      return { diaryUpdated: true } as DinnerOutput
    }),
}
