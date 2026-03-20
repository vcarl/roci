import * as path from "node:path"
import * as process from "node:process"
import { Effect } from "effect"
import { Claude } from "../../../services/Claude.js"
import { CharacterFs, type CharacterConfig } from "../../../services/CharacterFs.js"
import { CharacterLog } from "../../../logging/log-writer.js"
import { loadTemplate } from "../../template.js"

export type DreamType = "normal" | "good" | "nightmare"

export interface DreamInput {
  char: CharacterConfig
}

export interface DreamOutput {
  dreamType: DreamType
  diaryCompressed: boolean
  secretsCompressed: boolean
}

interface DreamTypeSelection {
  dreamType: DreamType
  roll: number
  nightmareThreshold: number
  goodThreshold: number
  secretsLineCount: number
}

function selectDreamType(secretsLineCount: number): DreamTypeSelection {
  const nightmareThreshold = Math.min(secretsLineCount / 6, 15)
  const roll = Math.floor(Math.random() * 100)
  const goodThreshold = 94
  let dreamType: DreamType
  if (roll < nightmareThreshold) dreamType = "nightmare"
  else if (roll >= goodThreshold) dreamType = "good"
  else dreamType = "normal"
  return { dreamType, roll, nightmareThreshold, goodThreshold, secretsLineCount }
}

const PROMPTS_DIR = path.resolve(import.meta.dirname, "prompts")

const diaryTemplateFile: Record<DreamType, string> = {
  normal: "dream-diary.md",
  good: "dream-diary-good.md",
  nightmare: "dream-diary-nightmare.md",
}

const secretsTemplateFile: Record<DreamType, string> = {
  normal: "dream-secrets.md",
  good: "dream-secrets-good.md",
  nightmare: "dream-secrets-nightmare.md",
}

export const dream = {
  name: "dream" as const,
  execute: (input: DreamInput) =>
    Effect.gen(function* () {
      const claude = yield* Claude
      const charFs = yield* CharacterFs
      const log = yield* CharacterLog

      const diary = yield* charFs.readDiary(input.char)
      const secrets = yield* charFs.readSecrets(input.char)
      const background = yield* charFs.readBackground(input.char)

      const secretsLines = secrets.split("\n").filter((l) => l.trim()).length
      const selection = selectDreamType(secretsLines)
      const { dreamType } = selection

      yield* log.thought(input.char, {
        timestamp: new Date().toISOString(),
        source: "dream",
        character: input.char.name,
        type: "dream_type_selection",
        dreamType,
        roll: selection.roll,
        nightmareThreshold: selection.nightmareThreshold,
        goodThreshold: selection.goodThreshold,
        secretsLineCount: selection.secretsLineCount,
      })

      yield* log.thought(input.char, {
        timestamp: new Date().toISOString(),
        source: "dream",
        character: input.char.name,
        type: "dream_start",
        dreamType,
      })

      // 1. Compress diary
      const diaryPrompt = yield* loadTemplate(path.join(PROMPTS_DIR, diaryTemplateFile[dreamType]))
      const diaryInput = `${diaryPrompt}\n\n<context name="background">\n${background}\n</context>\n\n<context name="secrets">\n${secrets}\n</context>\n\n${diary}`

      // Use configured model: OPENROUTER_DREAM_MODEL or BRAIN_MODEL fallback, default "haiku"
      const dreamModel = process.env.OPENROUTER_DREAM_MODEL || process.env.BRAIN_MODEL || "haiku"

      const compressedDiary = yield* claude.invoke({
        prompt: diaryInput,
        model: dreamModel as any,
        outputFormat: "text",
        maxTurns: 1,
      })

      yield* charFs.writeDiary(input.char, compressedDiary)

      yield* log.thought(input.char, {
        timestamp: new Date().toISOString(),
        source: "dream",
        character: input.char.name,
        type: "dream_diary_compressed",
        dreamType,
        originalLength: diary.length,
        compressedLength: compressedDiary.length,
        content: compressedDiary.slice(0, 2000),
      })

      // 2. Compress secrets
      const secretsPrompt = yield* loadTemplate(path.join(PROMPTS_DIR, secretsTemplateFile[dreamType]))
      const secretsInput = `${secretsPrompt}\n\n<context name="background">\n${background}\n</context>\n\n<context name="diary">\n${compressedDiary}\n</context>\n\n${secrets}`

      const compressedSecrets = yield* claude.invoke({
        prompt: secretsInput,
        model: dreamModel, // reuse same model
        outputFormat: "text",
        maxTurns: 1,
      })

      yield* charFs.writeSecrets(input.char, compressedSecrets)

      yield* log.thought(input.char, {
        timestamp: new Date().toISOString(),
        source: "dream",
        character: input.char.name,
        type: "dream_secrets_compressed",
        dreamType,
        originalLength: secrets.length,
        compressedLength: compressedSecrets.length,
        content: compressedSecrets.slice(0, 2000),
      })

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
