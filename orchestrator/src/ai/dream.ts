import { Effect } from "effect"
import { Claude } from "../services/Claude.js"
import { CharacterFs, type CharacterConfig } from "../services/CharacterFs.js"
import { PromptTemplates } from "../services/PromptTemplates.js"
import { CharacterLog } from "../logging/log-writer.js"

export type DreamType = "normal" | "good" | "nightmare"

export interface DreamInput {
  char: CharacterConfig
}

export interface DreamOutput {
  dreamType: DreamType
  diaryCompressed: boolean
  secretsCompressed: boolean
}

function selectDreamType(secretsLineCount: number): DreamType {
  const nightmareChance = Math.min(secretsLineCount / 6, 15)
  const roll = Math.floor(Math.random() * 100)
  if (roll < nightmareChance) return "nightmare"
  if (roll >= 94) return "good"
  return "normal"
}

export const dream = {
  name: "dream" as const,
  execute: (input: DreamInput) =>
    Effect.gen(function* () {
      const claude = yield* Claude
      const charFs = yield* CharacterFs
      const templates = yield* PromptTemplates
      const log = yield* CharacterLog

      const diary = yield* charFs.readDiary(input.char)
      const secrets = yield* charFs.readSecrets(input.char)
      const background = yield* charFs.readBackground(input.char)

      const secretsLines = secrets.split("\n").filter((l) => l.trim()).length
      const dreamType = selectDreamType(secretsLines)

      yield* log.thought(input.char, {
        timestamp: new Date().toISOString(),
        source: "dream",
        character: input.char.name,
        type: "dream_start",
        dreamType,
      })

      // 1. Compress diary
      const diaryPrompt = yield* templates.getDreamDiaryPrompt(dreamType)
      const diaryInput = `${diaryPrompt}\n\n<context name="background">\n${background}\n</context>\n\n<context name="secrets">\n${secrets}\n</context>\n\n${diary}`

      const compressedDiary = yield* claude.invoke({
        prompt: diaryInput,
        model: "opus",
        outputFormat: "text",
        maxTurns: 1,
      })

      yield* charFs.writeDiary(input.char, compressedDiary)

      // 2. Compress secrets
      const secretsPrompt = yield* templates.getDreamSecretsPrompt(dreamType)
      const secretsInput = `${secretsPrompt}\n\n<context name="background">\n${background}\n</context>\n\n<context name="diary">\n${compressedDiary}\n</context>\n\n${secrets}`

      const compressedSecrets = yield* claude.invoke({
        prompt: secretsInput,
        model: "opus",
        outputFormat: "text",
        maxTurns: 1,
      })

      yield* charFs.writeSecrets(input.char, compressedSecrets)

      yield* log.thought(input.char, {
        timestamp: new Date().toISOString(),
        source: "dream",
        character: input.char.name,
        type: "dream_complete",
        dreamType,
        diaryCompressed: true,
        secretsCompressed: true,
      })

      return { dreamType, diaryCompressed: true, secretsCompressed: true } as DreamOutput
    }),
}
