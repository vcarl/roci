import { Effect } from "effect"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import type { DomainConfig } from "./domain-bundle.js"
import type { CortexModelConfig } from "../model/handles.js"
import type { ModelClient } from "../model/client.js"
import type { ModelService } from "../services/ModelService.js"
import type { ModelError } from "../model/errors.js"
import type { SpawnError, ReadinessError } from "../services/model-backend.js"
import { TEMPLATE_PALETTE, paletteFile, MalformedAxisError } from "./palette.js"
import {
  renderSalienceLines,
  salienceFile,
  parseSalience,
  buildAxisList,
  unknownSalienceAxes,
  AxisCollisionError,
  UnknownAxisError,
} from "./salience.js"
import { renderDriveLines, drivesFile } from "#brain/limbic/hypothalamus/drives.js"
import {
  promptForStep,
  type IdentityContext,
  type IdentityStep,
} from "./identity-gen/prompts.js"
import { generateArtifact, EmptyGenerationError } from "./identity-gen/generate.js"
import { makeCharacterConfig } from "../services/CharacterFs.js"
import { meDir } from "../services/character-paths.js"

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

/**
 * An identity artifact EXISTS on disk but could not be read (EISDIR, EACCES, a
 * mid-run delete). Distinct from a malformed one: the file's CONTENT was never
 * seen, so nothing can be said about its shape.
 *
 * It has its own type because the alternative was reusing `MalformedAxisError`,
 * whose message is fixed text naming a malformed *palette axis line* and telling
 * the operator to fix `PALETTE.md`. Two of the three reads below are of
 * `DRIVES.md` and `SALIENCE.md`, so that report named the wrong file as well as
 * the wrong problem, and `.line` — documented as the offending palette row — held
 * a filesystem error string. A typed failure that misdirects the operator is the
 * same failure class as one that never fires: it looks handled.
 *
 * It lives HERE, not in `@roci/player-tools/axis-vocab` beside its siblings, on
 * purpose. That module is the vocabulary shared with the in-container `memory`
 * CLI and is deliberately import-free and I/O-free; "an artifact on disk could
 * not be read" is a host-side scaffold concern, produced by exactly one function
 * (`bodyOnDisk`, below) and by nothing else. Same precedent as
 * `EmptyGenerationError` in `identity-gen/generate.ts`: the error lives with the
 * operation that raises it. Nothing inside core imports this module, so there is
 * no cycle to create.
 */
export class ArtifactUnreadableError extends Error {
  readonly _tag = "ArtifactUnreadableError"
  constructor(
    /** The artifact that could not be read — a resolved path. */
    readonly artifact: string,
    /** The underlying fs error, preserved rather than flattened to a string. */
    readonly cause: unknown,
  ) {
    super(
      `${artifact} exists but could not be read: ${String(cause)}. The file is ` +
        `present, so the salience axis vocabulary cannot be derived from it and ` +
        `must not be derived from the fallback instead — that would key this ` +
        `character's SALIENCE.md to an artifact nobody can read. Fix the file's ` +
        `permissions/type (a directory where a file should be is the usual cause) ` +
        `and re-run.`,
    )
    this.name = "ArtifactUnreadableError"
  }
}

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
 * drives → salience → diary → summary against the local conscious cortex tier,
 * routing each
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
  | ModelError
  | SpawnError
  | ReadinessError
  | EmptyGenerationError
  | AxisCollisionError
  | MalformedAxisError
  | UnknownAxisError
  | ArtifactUnreadableError,
  ModelClient | ModelService
> =>
  Effect.gen(function* () {
    const { projectRoot, characterName, identityTemplate, characterDescription } = opts
    const review = opts.review ?? autoAcceptReview
    const charDir = meDir(makeCharacterConfig(projectRoot, characterName))
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
    let salienceBody = renderSalienceLines(domainDrives)
    let diaryContent = DIARY_TEMPLATE
    let summary: string | undefined

    // `ctx` is hoisted above the split so both halves of the generation run share
    // one context object. Its `characterDescription` is only ever READ inside the
    // guarded blocks below, so the `?? ""` can never reach a prompt.
    const ctx: IdentityContext = {
      characterName,
      characterDescription: characterDescription ?? "",
      identityTemplate,
      baseDrives: driveBody,
    }

    // Block 1 — the artifacts the axis vocabulary is DERIVED FROM.
    if (characterDescription) {
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
      // (`ctx.baseDrives` is re-threaded from the EFFECTIVE drive body below, so
      // the salience step weights the drives that will actually be on disk.)
    }

    // ── THE ARTIFACTS THE VOCABULARY IS DERIVED FROM ──
    // The invariant: the derived vocabulary must match the vocabulary of the
    // artifacts that will ACTUALLY EXIST on disk when this returns.
    //
    // The write loop below never overwrites, so when PALETTE.md / DRIVES.md are
    // already on disk the in-memory body generated moments ago is discarded and
    // the on-disk one persists. Deriving from the in-memory body there would key
    // a freshly written SALIENCE.md to a palette nobody will ever read — the two
    // artifacts disagreeing about the vocabulary, silently, which is precisely
    // the failure class this design exists to prevent. And it is not a corner
    // case: "delete the one artifact and re-run" is the blessed way to regenerate
    // a single file, which takes exactly this path.
    // THROWS on an unreadable-but-present artifact. Every caller below sits
    // inside an `Effect.try`, so an fs error becomes a TYPED failure the setup
    // command can catch — not a defect that kills the fiber. `existsSync` says
    // the file is there; a throw from `readFileSync` then means it is there and
    // unreadable (EISDIR, EACCES, a mid-run delete), and deriving a vocabulary
    // from the fallback in that case would key SALIENCE.md to an artifact nobody
    // can read.
    //
    // The thrown type names THIS artifact and carries the underlying fs error
    // (`ArtifactUnreadableError`). It used to throw `MalformedAxisError`, whose
    // fixed message accused a malformed PALETTE.md axis line — false for the
    // DRIVES.md and SALIENCE.md reads, and misdirecting for all three.
    const bodyOnDisk = (name: string, inMemory: string): string => {
      const p = path.resolve(charDir, name)
      if (!existsSync(p)) return inMemory
      try {
        return readFileSync(p, "utf-8")
      } catch (e) {
        throw new ArtifactUnreadableError(p, e)
      }
    }

    // ── THE SINGLE AXIS-DERIVATION SITE ──
    // The flat axis namespace: core drives + domain drives (from the approved
    // DRIVES.md body) then one axis per approved PALETTE.md row, named from its
    // pole pair (design 2026-07-31 §1). Both failure modes are loud and TYPED: a
    // malformed palette row (MalformedAxisError) and a duplicate axis name
    // (AxisCollisionError). Membership is derived now, so neither is something to
    // resolve silently. This runs on BOTH paths — generated and plain-template —
    // and before any file is written.
    // Both parsers read a whole artifact file as happily as a bare body:
    // `parseDriveNames` anchors on `^- <name> —` and `parsePaletteAxes` skips the
    // heading and the comment block, so no header stripping is needed here. The
    // READS are inside this Effect.try too (R3): an unreadable artifact must
    // reach the caller as a typed failure, exactly like a malformed one.
    //
    // Only the EXPECTED throws are typed failures. Anything else is a DEFECT and
    // is re-thrown as one: this `catch` used to end `: new
    // AxisCollisionError(String(e))`, which reported every unexpected exception as
    // a duplicate salience axis — `.axis` holding a stringified stack, the message
    // sending the operator to fix a DRIVES.md that was never the problem, and the
    // setup command's per-character catch then swallowing it as a known
    // vocabulary defect. A bug that looks handled is the exact failure class this
    // subsystem exists to refuse. `Effect.die` keeps the error union honest too —
    // it never gains an `unknown` member.
    const derived = yield* Effect.try({
      try: () => {
        const effectiveDriveBody = bodyOnDisk("DRIVES.md", driveBody)
        const effectivePaletteBody = bodyOnDisk("PALETTE.md", paletteBody)
        return {
          effectiveDriveBody,
          effectivePaletteBody,
          axes: buildAxisList(effectiveDriveBody, effectivePaletteBody),
        }
      },
      catch: (e) => e,
    }).pipe(
      Effect.catchAll((e) =>
        e instanceof AxisCollisionError ||
        e instanceof MalformedAxisError ||
        e instanceof ArtifactUnreadableError
          ? Effect.fail(e)
          : Effect.die(e),
      ),
    )
    const { effectiveDriveBody, effectivePaletteBody, axes } = derived
    // The salience prompt enumerates `salienceAxes`; `palette` and `baseDrives`
    // ride along as context so the model can see the gradient and the drive
    // glosses each derived name came from. All three come from the SAME effective
    // bodies the axes were derived from — the model is never shown one vocabulary
    // and asked to weight another.
    ctx.palette = effectivePaletteBody
    ctx.baseDrives = effectiveDriveBody
    ctx.salienceAxes = axes

    // Block 2 — the artifact SCORED AGAINST that vocabulary, then the rest.
    if (characterDescription) {
      const sal = yield* runStep("salience", ctx, opts.cortexModels, review)
      if (sal.kind === "content") salienceBody = sal.value.trim()

      const diary = yield* runStep("diary", ctx, opts.cortexModels, review)
      if (diary.kind === "content") diaryContent = diary.value.trim() + "\n"

      const sum = yield* runStep("summary", ctx, opts.cortexModels, review)
      if (sum.kind === "content") summary = sum.value.trim()

      results.push(`generated identity for ${characterName}`)
    }

    // A profile key outside the derived axis list is a generation defect, not
    // character-specific data (design 2026-07-31 §1-§2). This is also the guard
    // that catches a `- Volatility: <n>` line written WITH a leading dash, which
    // parseSalience would otherwise admit as a phantom axis. MISSING axes are not
    // reported: the drive-only template fallback is legitimate (§8).
    //
    // Validate the body that will ACTUALLY BE ON DISK when this returns, exactly
    // as the derivation inputs above do. The write loop never overwrites, so a
    // pre-existing SALIENCE.md wins over the one generated moments ago — and a
    // stale profile keyed to a retired vocabulary is precisely what this check
    // exists to catch. Validating the in-memory body instead would pass a
    // character whose on-disk profile disagrees with their on-disk palette:
    // inert, clean, and unnoticed. (The mirror of the bug bodyOnDisk fixed for
    // the derivation inputs — same file, same reasoning, other direction.)
    // `bodyOnDisk` raises exactly one expected type; everything else is a defect,
    // for the same reason as the derivation site above.
    const effectiveSalienceBody = yield* Effect.try({
      try: () => bodyOnDisk("SALIENCE.md", salienceBody),
      catch: (e) => e,
    }).pipe(
      Effect.catchAll((e) =>
        e instanceof ArtifactUnreadableError ? Effect.fail(e) : Effect.die(e),
      ),
    )
    const unknown = unknownSalienceAxes(parseSalience(effectiveSalienceBody), axes)
    if (unknown.length > 0) return yield* Effect.fail(new UnknownAxisError(unknown, axes))

    const files: Array<{ name: string; content: string }> = [
      { name: "background.md", content: backgroundContent },
      { name: "VALUES.md", content: valuesContent },
      { name: "PALETTE.md", content: paletteFile(paletteBody) },
      { name: "DRIVES.md", content: drivesFile(driveBody) },
      { name: "SALIENCE.md", content: salienceFile(salienceBody) },
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
