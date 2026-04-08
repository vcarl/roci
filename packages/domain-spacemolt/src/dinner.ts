import * as path from "node:path"
import { Effect } from "effect"
import { FileSystem, CommandExecutor } from "@effect/platform"
import { ClaudeError } from "@roci/core/services/Claude.js"
import { CharacterFs, type CharacterConfig } from "@roci/core/services/CharacterFs.js"
import { CharacterLog } from "@roci/core/logging/log-writer.js"
import { ProjectRoot } from "@roci/core/services/ProjectRoot.js"
import { renderTemplate, loadTemplate } from "@roci/core/core/template.js"
import { runTurn } from "@roci/core/core/limbic/hypothalamus/process-runner.js"
import { OAuthToken } from "@roci/core/services/OAuthToken.js"
import type { ModelConfig } from "@roci/core/core/model-config.js"
import { resolveModel } from "@roci/core/core/model-config.js"

export interface DinnerInput {
  char: CharacterConfig
  containerId: string
  playerName: string
  addDirs?: string[]
  env?: Record<string, string>
  models: ModelConfig
}

export interface DinnerOutput {
  diaryUpdated: boolean
}

const PROMPTS_DIR = path.resolve(import.meta.dirname, "prompts")

export const dinner = {
  name: "dinner" as const,
  execute: (input: DinnerInput) =>
    Effect.gen(function* () {
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

      const result = yield* runTurn({
        containerId: input.containerId,
        playerName: input.playerName,
        char: input.char,
        prompt,
        systemPrompt: "",
        model: resolveModel(input.models, "dinner", "smart"),
        timeoutMs: 120_000,
        role: "brain",
        noTools: true,
        addDirs: input.addDirs,
        env: input.env,
      })
      const updatedDiary = result.output

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
