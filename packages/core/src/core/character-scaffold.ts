import { Effect } from "effect"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import type { DomainConfig } from "./domain-bundle.js"
import type { CortexModelConfig } from "../model/handles.js"
import type { ModelClient } from "../model/client.js"
import type { ModelService } from "../services/ModelService.js"
import type { ModelError } from "../model/errors.js"
import type { SpawnError, ReadinessError } from "../services/model-backend.js"
import { TEMPLATE_PALETTE, paletteFile } from "./palette.js"
import { renderDriveLines, drivesFile } from "#brain/limbic/hypothalamus/drives.js"
import {
  promptForStep,
  type IdentityContext,
  type IdentityStep,
} from "./identity-gen/prompts.js"
import { generateArtifact, EmptyGenerationError } from "./identity-gen/generate.js"

const BACKGROUND_TEMPLATE = `# Background

<!-- Write your character's background here. This is their identity narrative —
     who they are, how they think, what drives them. The AI reads this on every
     planning cycle to stay in character. -->
`
const VALUES_TEMPLATE = `# Values

<!-- Write your character's working values here. These define how the character
     operates — their priorities, principles, and decision-making framework. -->
`
const DIARY_TEMPLATE = `# Diary
`
const SECRETS_TEMPLATE = `# Secrets
`

/** Operator's decision on a generated artifact during the interactive review. */
export type ReviewDecision =
  | { action: "accept"; content: string }
  | { action: "regenerate"; feedback?: string }
  | { action: "skip" }

/** Injected by the caller (the app's setup UI) to review each generated step.
 *  Keeping it a callback keeps interactive @effect/cli Prompt out of core. */
export type ReviewFn = (step: IdentityStep, content: string) => Effect.Effect<ReviewDecision>

/** Non-interactive default — accept every generated artifact unchanged. */
export const autoAcceptReview: ReviewFn = (_step, content) =>
  Effect.succeed({ action: "accept", content })

type StepOutcome = { kind: "content"; value: string } | { kind: "skip" }

/** Generate one step, looping on `regenerate` (threading feedback) until the
 *  operator accepts (with possibly-edited content) or skips. */
const runStep = (
  step: IdentityStep,
  ctx: IdentityContext,
  cortexModels: CortexModelConfig | undefined,
  review: ReviewFn,
): Effect.Effect<
  StepOutcome,
  ModelError | SpawnError | ReadinessError | EmptyGenerationError,
  ModelClient | ModelService
> =>
  Effect.gen(function* () {
    let feedback: string | undefined
    // bounded loop guard against a pathological regenerate cycle
    for (let attempt = 0; attempt < 20; attempt++) {
      const prompt = promptForStep(step, { ...ctx, feedback })
      const content = yield* generateArtifact(step, prompt, cortexModels)
      const decision = yield* review(step, content)
      if (decision.action === "accept") return { kind: "content", value: decision.content }
      if (decision.action === "skip") return { kind: "skip" }
      feedback = decision.feedback
    }
    return { kind: "skip" }
  })

/**
 * Scaffold a new character's identity files under `players/<name>/me/`.
 *
 * With a `characterDescription`, generates background → values → palette →
 * diary → summary against the local conscious cortex tier, routing each
 * artifact through the injected `review` callback (accept / edit / regenerate /
 * skip). Without a description, writes plain seed templates and makes no model
 * call. Fails hard on a model/readiness/empty-content error — it never writes a
 * boilerplate file and reports success. Existing files are never overwritten.
 */
export const scaffoldCharacter = (opts: {
  projectRoot: string
  characterName: string
  identityTemplate?: { backgroundHints: string; valuesHints: string }
  characterDescription?: string
  cortexModels?: CortexModelConfig
  domainConfig: DomainConfig
  review?: ReviewFn
}): Effect.Effect<
  { results: string[]; summary?: string },
  ModelError | SpawnError | ReadinessError | EmptyGenerationError,
  ModelClient | ModelService
> =>
  Effect.gen(function* () {
    const { projectRoot, characterName, identityTemplate, characterDescription } = opts
    const review = opts.review ?? autoAcceptReview
    const charDir = path.resolve(projectRoot, "players", characterName, "me")
    const results: string[] = []

    if (!existsSync(charDir)) {
      mkdirSync(charDir, { recursive: true })
      results.push(`created directory: ${charDir}`)
    }

    // Defaults = plain templates (used with no description, or on an explicit skip).
    let backgroundContent = identityTemplate
      ? BACKGROUND_TEMPLATE + `\n## Domain Context\n\n${identityTemplate.backgroundHints}\n`
      : BACKGROUND_TEMPLATE
    let valuesContent = identityTemplate
      ? VALUES_TEMPLATE + `\n## Domain Context\n\n${identityTemplate.valuesHints}\n`
      : VALUES_TEMPLATE
    let paletteBody = TEMPLATE_PALETTE
    // Core drives + this domain's drives — the scaffold default; identity-gen may
    // personalize the descriptions/voice while the names stay stable (§3.3).
    const domainDrives = opts.domainConfig.identityTemplate?.domainDrives
    let driveBody = renderDriveLines(domainDrives)
    let diaryContent = DIARY_TEMPLATE
    let summary: string | undefined

    if (characterDescription) {
      const ctx: IdentityContext = {
        characterName,
        characterDescription,
        identityTemplate,
        baseDrives: driveBody,
      }

      const bg = yield* runStep("background", ctx, opts.cortexModels, review)
      if (bg.kind === "content") {
        backgroundContent = bg.value.trim() + "\n"
        ctx.background = bg.value.trim()
      }

      const val = yield* runStep("values", ctx, opts.cortexModels, review)
      if (val.kind === "content") {
        valuesContent = val.value.trim() + "\n"
        ctx.values = val.value.trim()
      }

      const pal = yield* runStep("palette", ctx, opts.cortexModels, review)
      if (pal.kind === "content") paletteBody = pal.value.trim()

      const drv = yield* runStep("drives", ctx, opts.cortexModels, review)
      if (drv.kind === "content") driveBody = drv.value.trim()

      const diary = yield* runStep("diary", ctx, opts.cortexModels, review)
      if (diary.kind === "content") diaryContent = diary.value.trim() + "\n"

      const sum = yield* runStep("summary", ctx, opts.cortexModels, review)
      if (sum.kind === "content") summary = sum.value.trim()

      results.push(`generated identity for ${characterName}`)
    }

    const files: Array<{ name: string; content: string }> = [
      { name: "background.md", content: backgroundContent },
      { name: "VALUES.md", content: valuesContent },
      { name: "PALETTE.md", content: paletteFile(paletteBody) },
      { name: "DRIVES.md", content: drivesFile(driveBody) },
      { name: "DIARY.md", content: diaryContent },
      { name: "SECRETS.md", content: SECRETS_TEMPLATE },
    ]

    for (const file of files) {
      const filePath = path.resolve(charDir, file.name)
      if (existsSync(filePath)) {
        results.push(`skipped: ${filePath} (already exists)`)
      } else {
        writeFileSync(filePath, file.content)
        results.push(`created: ${filePath}`)
      }
    }

    return { results, summary }
  })
