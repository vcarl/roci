import { Effect } from "effect"
import { FileSystem } from "@effect/platform"
import * as path from "node:path"
import { Claude } from "../services/Claude.js"
import { CharacterFs, type CharacterConfig } from "../services/CharacterFs.js"
import { PromptTemplates } from "../services/PromptTemplates.js"
import { CharacterLog } from "../logging/log-writer.js"

export interface DinnerInput {
  char: CharacterConfig
  projectRoot: string
}

export interface DinnerOutput {
  diaryUpdated: boolean
}

export const dinner = {
  name: "dinner" as const,
  execute: (input: DinnerInput) =>
    Effect.gen(function* () {
      const claude = yield* Claude
      const charFs = yield* CharacterFs
      const templates = yield* PromptTemplates
      const log = yield* CharacterLog
      const fs = yield* FileSystem.FileSystem

      yield* log.thought(input.char, {
        timestamp: new Date().toISOString(),
        source: "dinner",
        character: input.char.name,
        type: "dinner_start",
      })

      // Read recent thoughts log as session report
      const thoughtsPath = path.resolve(
        input.projectRoot,
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

      const dinnerTemplate = yield* templates.getDinnerPrompt()

      const prompt = dinnerTemplate
        .replace("{{SESSION_REPORT}}", sessionReport)
        .replace("{{DIARY}}", diary)
        .replace("{{VALUES}}", values)

      const updatedDiary = yield* claude.invoke({
        prompt,
        model: "opus",
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
