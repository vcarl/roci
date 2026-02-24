import { Context, Effect, Layer } from "effect"
import { FileSystem } from "@effect/platform"
import * as path from "node:path"

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
    readonly getInGameClaudeMd: () => Effect.Effect<string, PromptTemplateError>
  }
>() {}

export const makePromptTemplatesLive = (projectRoot: string) =>
  Layer.effect(
    PromptTemplates,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const templateDir = path.resolve(projectRoot, ".devcontainer")

      const readTemplate = (filename: string) =>
        fs.readFileString(path.join(templateDir, filename)).pipe(
          Effect.mapError(
            (e) => new PromptTemplateError(`Failed to read template ${filename}`, e),
          ),
        )

      const dreamDiaryFilename = (dreamType: "normal" | "good" | "nightmare") => {
        if (dreamType === "good") return "good-dream-diary-prompt.txt"
        if (dreamType === "nightmare") return "nightmare-diary-prompt.txt"
        return "dream-diary-prompt.txt"
      }

      const dreamSecretsFilename = (dreamType: "normal" | "good" | "nightmare") => {
        if (dreamType === "good") return "good-dream-secrets-prompt.txt"
        if (dreamType === "nightmare") return "nightmare-secrets-prompt.txt"
        return "dream-secrets-prompt.txt"
      }

      return PromptTemplates.of({
        getSessionPrompt: () => readTemplate("session-prompt.txt"),
        getDinnerPrompt: () => readTemplate("dinner-prompt.txt"),
        getDreamDiaryPrompt: (dreamType) => readTemplate(dreamDiaryFilename(dreamType)),
        getDreamSecretsPrompt: (dreamType) => readTemplate(dreamSecretsFilename(dreamType)),
        getInGameClaudeMd: () =>
          fs.readFileString(path.resolve(projectRoot, "in-game-CLAUDE.md")).pipe(
            Effect.mapError(
              (e) => new PromptTemplateError("Failed to read in-game-CLAUDE.md", e),
            ),
          ),
      })
    }),
  )
