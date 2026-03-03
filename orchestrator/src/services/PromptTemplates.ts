import { Context, Effect, Layer } from "effect"
import { fileURLToPath } from "node:url"
import * as path from "node:path"
import { loadTemplate } from "../core/template.js"

export class PromptTemplateError {
  readonly _tag = "PromptTemplateError"
  constructor(readonly message: string, readonly cause?: unknown) {}
}

export class PromptTemplates extends Context.Tag("PromptTemplates")<
  PromptTemplates,
  {
    readonly getSessionPrompt: () => Effect.Effect<string, PromptTemplateError>
    readonly getDinnerPrompt: () => Effect.Effect<string, PromptTemplateError>
    readonly getDreamDiaryPrompt: (dreamType: "normal" | "good" | "nightmare") => Effect.Effect<string, PromptTemplateError>
    readonly getDreamSecretsPrompt: (dreamType: "normal" | "good" | "nightmare") => Effect.Effect<string, PromptTemplateError>
  }
>() {}

const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../core/prompts")

const read = (filename: string) =>
  loadTemplate(path.join(PROMPTS_DIR, filename)).pipe(
    Effect.mapError(
      (e) => new PromptTemplateError(`Failed to read template ${filename}`, e),
    ),
  )

export const PromptTemplatesLive = Layer.effect(
  PromptTemplates,
  Effect.gen(function* () {
    // Eagerly load all templates at construction
    const session = yield* read("session.md")
    const dinner = yield* read("dinner.md")
    const dreamDiary = yield* read("dream-diary.md")
    const dreamDiaryGood = yield* read("dream-diary-good.md")
    const dreamDiaryNightmare = yield* read("dream-diary-nightmare.md")
    const dreamSecrets = yield* read("dream-secrets.md")
    const dreamSecretsGood = yield* read("dream-secrets-good.md")
    const dreamSecretsNightmare = yield* read("dream-secrets-nightmare.md")

    const diaryByType = { normal: dreamDiary, good: dreamDiaryGood, nightmare: dreamDiaryNightmare }
    const secretsByType = { normal: dreamSecrets, good: dreamSecretsGood, nightmare: dreamSecretsNightmare }

    return PromptTemplates.of({
      getSessionPrompt: () => Effect.succeed(session),
      getDinnerPrompt: () => Effect.succeed(dinner),
      getDreamDiaryPrompt: (dreamType) => Effect.succeed(diaryByType[dreamType]),
      getDreamSecretsPrompt: (dreamType) => Effect.succeed(secretsByType[dreamType]),
    })
  }),
)
