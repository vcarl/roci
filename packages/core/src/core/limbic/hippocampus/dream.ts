import * as path from "node:path"
import { Effect } from "effect"
import { CharacterFs, type CharacterConfig } from "../../../services/CharacterFs.js"
import { CharacterLog, logToConsole } from "../../../logging/log-writer.js"
import { eventBase } from "../../../logging/events.js"
import { loadTemplate, renderTemplate } from "../../template.js"
import { runTurn } from "../hypothalamus/process-runner.js"
import type { ModelConfig } from "../../model-config.js"
import { resolveModel } from "../../model-config.js"

/**
 * Stable target the cull compresses the diary toward (lines). The cull prompt is
 * instructed to aim at this size; the hard never-grows invariant below guarantees
 * the file can never end up larger than its input regardless of model behavior.
 */
export const DIARY_TARGET_LINES = 150

/** Count lines the same way the diary/secrets sizing is measured elsewhere. */
const lineCount = (s: string) => s.split("\n").length

export type DreamType = "normal" | "good" | "nightmare"

export interface DreamInput {
  char: CharacterConfig
  containerId: string
  playerName: string
  addDirs?: string[]
  env?: Record<string, string>
  models: ModelConfig
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
      const charFs = yield* CharacterFs
      const log = yield* CharacterLog

      const diary = yield* charFs.readDiary(input.char)
      const secrets = yield* charFs.readSecrets(input.char)
      const background = yield* charFs.readBackground(input.char)

      const dreamModel = resolveModel(input.models, "dreamCompression", "smart")

      const secretsLines = secrets.split("\n").filter((l) => l.trim()).length
      const selection = selectDreamType(secretsLines)
      const { dreamType } = selection

      yield* log.emit(input.char, {
        ...eventBase(input.char.name, "orchestrator", "dream"),
        kind: "text",
        text: `dream_type_selection: ${dreamType} (roll=${selection.roll}, nightmare<${selection.nightmareThreshold}, good>=${selection.goodThreshold}, secrets=${selection.secretsLineCount})`,
      })

      yield* log.emit(input.char, {
        ...eventBase(input.char.name, "orchestrator", "dream"),
        kind: "text",
        text: `dream_start: ${dreamType}`,
      })

      // 1. Compress diary (cull) — aim at DIARY_TARGET_LINES.
      const diaryPromptRaw = yield* loadTemplate(path.join(PROMPTS_DIR, diaryTemplateFile[dreamType]))
      const diaryPrompt = renderTemplate(diaryPromptRaw, { TARGET_LINES: String(DIARY_TARGET_LINES) })
      const diaryInput = `${diaryPrompt}\n\n<context name="background">\n${background}\n</context>\n\n<context name="secrets">\n${secrets}\n</context>\n\n${diary}`

      const compressedDiary = yield* runTurn({
        containerId: input.containerId,
        playerName: input.playerName,
        char: input.char,
        prompt: diaryInput,
        systemPrompt: "",
        model: dreamModel,
        timeoutMs: 120_000,
        role: "brain",
        noTools: true,
        addDirs: input.addDirs,
        env: input.env,
      }).pipe(Effect.map((r) => r.output))

      // Hard invariant: the cull must never produce a larger file than its input.
      // If the model returned more lines than it was given, discard and keep the original.
      let finalDiary = compressedDiary
      let diaryCompressed = true
      if (lineCount(compressedDiary) > lineCount(diary)) {
        finalDiary = diary
        diaryCompressed = false
        yield* logToConsole(
          input.char.name,
          "orchestrator",
          `dream_diary_compression_discarded: cull produced ${lineCount(compressedDiary)} lines > ${lineCount(diary)} input lines — keeping original diary`,
          "warn",
        )
      } else {
        yield* charFs.writeDiary(input.char, compressedDiary)
        yield* log.emit(input.char, {
          ...eventBase(input.char.name, "orchestrator", "dream"),
          kind: "text",
          text: `dream_diary_compressed: ${dreamType} (${diary.length} -> ${compressedDiary.length})`,
        })
      }

      // 2. Compress secrets
      const secretsPrompt = yield* loadTemplate(path.join(PROMPTS_DIR, secretsTemplateFile[dreamType]))
      const secretsInput = `${secretsPrompt}\n\n<context name="background">\n${background}\n</context>\n\n<context name="diary">\n${finalDiary}\n</context>\n\n${secrets}`

      const compressedSecrets = yield* runTurn({
        containerId: input.containerId,
        playerName: input.playerName,
        char: input.char,
        prompt: secretsInput,
        systemPrompt: "",
        model: dreamModel,
        timeoutMs: 120_000,
        role: "brain",
        noTools: true,
        addDirs: input.addDirs,
        env: input.env,
      }).pipe(Effect.map((r) => r.output))

      // Same never-grows invariant for SECRETS.md.
      let secretsCompressed = true
      if (lineCount(compressedSecrets) > lineCount(secrets)) {
        secretsCompressed = false
        yield* logToConsole(
          input.char.name,
          "orchestrator",
          `dream_secrets_compression_discarded: cull produced ${lineCount(compressedSecrets)} lines > ${lineCount(secrets)} input lines — keeping original secrets`,
          "warn",
        )
      } else {
        yield* charFs.writeSecrets(input.char, compressedSecrets)
        yield* log.emit(input.char, {
          ...eventBase(input.char.name, "orchestrator", "dream"),
          kind: "text",
          text: `dream_secrets_compressed: ${dreamType} (${secrets.length} -> ${compressedSecrets.length})`,
        })
      }

      yield* log.emit(input.char, {
        ...eventBase(input.char.name, "orchestrator", "dream"),
        kind: "text",
        text: `dream_complete: ${dreamType}`,
      })

      return { dreamType, diaryCompressed, secretsCompressed } as DreamOutput
    }),
}
