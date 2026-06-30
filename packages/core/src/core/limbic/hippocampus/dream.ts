import * as path from "node:path"
import { Effect } from "effect"
import { CharacterFs, type CharacterConfig } from "../../../services/CharacterFs.js"
import { CharacterLog, logToConsole, logError } from "../../../logging/log-writer.js"
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

/**
 * Wall-clock budget for a reflection (cull/consolidate) turn. These run the local
 * reasoning model over the entire diary/secrets and can legitimately take minutes;
 * the prior 120s budget routinely timed out, and a timed-out turn returns empty
 * output that — absent the blank-turn guard below — silently wiped the file. 480s
 * (8min) sits safely under the conscious tier's 600s readiness budget. Shared with
 * the consolidate pass so both reflection writes use one source of truth.
 */
export const REFLECTION_TURN_TIMEOUT_MS = 480_000

/** Count lines the same way the diary/secrets sizing is measured elsewhere. */
const lineCount = (s: string) => s.split("\n").length

/**
 * A reflection turn produced NO usable content if it timed out or returned only
 * empty/whitespace text. Such a turn must be treated as a failure so the existing
 * content is preserved untouched — never overwritten with a blank file. (A timeout
 * does not throw: `runTurn` resolves with `{ output: "", timedOut: true }`, and an
 * empty string defeats the never-grows clamp because `lineCount("") === 1`.)
 */
const isBlankTurn = (r: { output: string; timedOut: boolean }): boolean =>
  r.timedOut || r.output.trim().length === 0

/** Reason string for a blank turn, for failure logging. */
const blankTurnReason = (r: { output: string; timedOut: boolean }): string =>
  r.timedOut ? "turn timed out (no output)" : "turn returned empty output"

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

      // A failed turn (e.g. the local mlx server is down or times out) must NOT
      // abort the dream — fall back to the ORIGINAL diary (the secrets prompt
      // embeds it below) and record the failure without writing.
      const diaryTurn = yield* runTurn({
        containerId: input.containerId,
        playerName: input.playerName,
        char: input.char,
        prompt: diaryInput,
        systemPrompt: "",
        model: dreamModel,
        timeoutMs: REFLECTION_TURN_TIMEOUT_MS,
        role: "brain",
        noTools: true,
        addDirs: input.addDirs,
        env: input.env,
      }).pipe(
        // A timeout or empty/whitespace output is a FAILED turn (runTurn does not
        // throw on timeout), not a valid 0-line compression — keep the original.
        Effect.map((r) =>
          isBlankTurn(r)
            ? { ok: false as const, reason: blankTurnReason(r) }
            : { ok: true as const, text: r.output },
        ),
        Effect.catchAll((e) => Effect.succeed({ ok: false as const, reason: String(e) })),
      )

      // Hard invariant: the cull must never produce a larger file than its input.
      // If the model returned more lines than it was given, discard and keep the original.
      let finalDiary: string
      let diaryCompressed: boolean
      if (!diaryTurn.ok) {
        finalDiary = diary
        diaryCompressed = false
        // Fail loud (Issue 2): a turn error is a genuine failure site, not the
        // expected never-grows clamp below — surface it as a structured kind:"error"
        // event. Best-effort continuation: keep the original and proceed to secrets.
        yield* logError(
          input.char.name,
          "hippocampus",
          `dream_diary_compression_failed: ${diaryTurn.reason} — keeping original`,
        )
      } else if (lineCount(diaryTurn.text) > lineCount(diary)) {
        finalDiary = diary
        diaryCompressed = false
        yield* logToConsole(
          input.char.name,
          "orchestrator",
          `dream_diary_compression_discarded: cull produced ${lineCount(diaryTurn.text)} lines > ${lineCount(diary)} input lines — keeping original diary`,
          "warn",
        )
      } else {
        finalDiary = diaryTurn.text
        diaryCompressed = true
        yield* charFs.writeDiary(input.char, diaryTurn.text)
        yield* log.emit(input.char, {
          ...eventBase(input.char.name, "orchestrator", "dream"),
          kind: "text",
          text: `dream_diary_compressed: ${dreamType} (${diary.length} -> ${diaryTurn.text.length})`,
        })
      }

      // 2. Compress secrets
      const secretsPrompt = yield* loadTemplate(path.join(PROMPTS_DIR, secretsTemplateFile[dreamType]))
      const secretsInput = `${secretsPrompt}\n\n<context name="background">\n${background}\n</context>\n\n<context name="diary">\n${finalDiary}\n</context>\n\n${secrets}`

      // Symmetric graceful fallback — a diary turn failure does NOT skip this
      // step, and a secrets turn failure keeps the original secrets without writing.
      const secretsTurn = yield* runTurn({
        containerId: input.containerId,
        playerName: input.playerName,
        char: input.char,
        prompt: secretsInput,
        systemPrompt: "",
        model: dreamModel,
        timeoutMs: REFLECTION_TURN_TIMEOUT_MS,
        role: "brain",
        noTools: true,
        addDirs: input.addDirs,
        env: input.env,
      }).pipe(
        // A timeout or empty/whitespace output is a FAILED turn (runTurn does not
        // throw on timeout), not a valid 0-line compression — keep the original.
        Effect.map((r) =>
          isBlankTurn(r)
            ? { ok: false as const, reason: blankTurnReason(r) }
            : { ok: true as const, text: r.output },
        ),
        Effect.catchAll((e) => Effect.succeed({ ok: false as const, reason: String(e) })),
      )

      // Same never-grows invariant for SECRETS.md.
      let secretsCompressed: boolean
      if (!secretsTurn.ok) {
        secretsCompressed = false
        // Fail loud (Issue 2): structured kind:"error" for a genuine turn failure,
        // distinct from the never-grows clamp; keep the original secrets.
        yield* logError(
          input.char.name,
          "hippocampus",
          `dream_secrets_compression_failed: ${secretsTurn.reason} — keeping original`,
        )
      } else if (lineCount(secretsTurn.text) > lineCount(secrets)) {
        secretsCompressed = false
        yield* logToConsole(
          input.char.name,
          "orchestrator",
          `dream_secrets_compression_discarded: cull produced ${lineCount(secretsTurn.text)} lines > ${lineCount(secrets)} input lines — keeping original secrets`,
          "warn",
        )
      } else {
        secretsCompressed = true
        yield* charFs.writeSecrets(input.char, secretsTurn.text)
        yield* log.emit(input.char, {
          ...eventBase(input.char.name, "orchestrator", "dream"),
          kind: "text",
          text: `dream_secrets_compressed: ${dreamType} (${secrets.length} -> ${secretsTurn.text.length})`,
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
