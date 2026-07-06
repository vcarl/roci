/**
 * Memory-index BOOTSTRAP stage (agent-cognition — the missing producer for the
 * SYNTHESIS.md orient/decide inject).
 *
 * me/SYNTHESIS.md is injected into every orient/decide prompt as the character's
 * MEMORY INDEX: a compact, scannable cheatsheet over its long-term vector memory
 * store (queried in-container via the `memory` CLI) — what knowledge, resources,
 * and open threads live in memory, organized by topic/source/tag, and what to
 * `memory search` to retrieve each. It is NOT identity prose (background.md and
 * values.md already cover who the character is). Its only steady-state producer
 * is the macro growth-stimulation stage (hippocampus/macro.ts), which fires just
 * once every Nth reflection (macroEveryN). Until the first macro cycle lands, a
 * fresh character — or one whose run dies before that cycle — renders the honest
 * but empty placeholder "(no memory index yet)" for its whole early life.
 *
 * This stage closes that gap: when SYNTHESIS.md is absent or blank, it synthesizes
 * an INITIAL index ONCE from the character's existing identity (background,
 * values, diary) via a single smart-tier turn, then writes it through macro's
 * bounded synthesis writer (writeSynthesisBounded — the same MAX_SYNTHESIS_CHARS
 * clamp). This early it is honestly sparse (there is barely any memory to index
 * yet). It is deliberately cheap and gated:
 *
 *  - GATE ON FILE CONTENT, not a counter — idempotent across sessions, never
 *    overwrites a real index. Once macro (or an earlier bootstrap) has written
 *    one, this stage skips entirely and runs no turn.
 *  - Placed BEFORE macro in runReflection, so on an Nth cycle macro's rewrite is
 *    continuous with (seeded by) the bootstrap rather than starting from empty.
 *  - NEVER-FAIL / anti-loss: a blank/timed-out/errored turn writes NOTHING — the
 *    placeholder keeps rendering honestly and a later reflection retries. It never
 *    writes a partial or empty file.
 *
 * House reflection-turn pattern (like dream/retrospect/macro): role:"brain",
 * noTools, the shared REFLECTION_TURN_TIMEOUT_MS budget, all inputs bounded in
 * code. The turn's whole output IS the index (not JSON — this is a bootstrap, not
 * the growth engine). The prompt frames the reply AS the artifact and forbids
 * tools/files, so the tool-capable in-container agent does not detour through its
 * Write tool and return chatter that lands verbatim at the wrong path.
 */
import { Effect } from "effect"
import type { CommandExecutor } from "@effect/platform"
import { CharacterFs, type CharacterConfig } from "../../../services/CharacterFs.js"
import { CharacterLog, logError } from "../../../logging/log-writer.js"
import { OAuthToken } from "../../../services/OAuthToken.js"
import { runTurn } from "../hypothalamus/process-runner.js"
import type { ModelConfig } from "../../model-config.js"
import { resolveModel } from "../../model-config.js"
import { REFLECTION_TURN_TIMEOUT_MS } from "./dream.js"
import { writeSynthesisBounded, MAX_SYNTHESIS_CHARS } from "./macro.js"

/** Per-source prompt-budget caps (bootstrap reads whole identity files raw). */
export const BOOTSTRAP_IDENTITY_MAX = 4000
export const BOOTSTRAP_DIARY_MAX = 6000

const truncate = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}…`)

export interface BootstrapInput {
  char: CharacterConfig
  containerId: string
  playerName: string
  addDirs?: string[]
  env?: Record<string, string>
  models: ModelConfig
}

export interface BootstrapOutput {
  bootstrapped: boolean
}

/**
 * The bootstrap turn prompt — seeds SYNTHESIS.md as a compact INDEX over the
 * character's long-term memory (what it knows and how to `memory search` it back),
 * NOT a self-portrait. Voice/format matches macro's reindex task (retrieval
 * pointers, grounded not invented, under the same bound) so macro's later
 * revisions read as a continuation of this initial, honestly-sparse draft. Frames
 * the reply AS the artifact and forbids tools/files so the tool-capable agent does
 * not detour through its Write tool.
 */
export function buildBootstrapPrompt(parts: {
  background: string
  values: string
  diary: string
}): string {
  return [
    "You are seeding, for the first time, a character's SYNTHESIS.md: a compact INDEX over the",
    "knowledge, resources, and open threads that live in its long-term memory. At decision time the",
    "character reads this index to know WHAT it knows and what to retrieve. It is NOT a description of",
    "the character — its background and values already cover its identity. Every line is a retrieval",
    "pointer, not self-description.",
    "",
    "Its long-term memory is a vector store it queries in its container with the `memory` CLI",
    "(`memory search \"<query>\"`, `memory recent -n N`); each memory carries a source, tags, and text.",
    "This index is the map over that store: entries name what is there and the `memory search` query",
    "(or tag) that pulls it back.",
    "",
    "It has written no index yet and is only just beginning, so its memory is nearly empty. Draw ONLY",
    "on what is given below to seed a first, honestly sparse index. Do not invent memories, resources,",
    "or threads it has not actually accumulated.",
    "",
    "## Its background",
    "",
    parts.background || "(none given)",
    "",
    "## Its values",
    "",
    parts.values || "(none given)",
    "",
    "## Its diary so far",
    "",
    parts.diary || "(empty — it is only just beginning)",
    "",
    "## What to write",
    "",
    "Write the index: organized by topic / resource / open thread, each entry a short line naming what",
    "lives in memory and the `memory search` query (or tag) that retrieves it. Be honest that this",
    "early it is mostly empty — a scaffold a larger reflective process will fill in later. Keep it true",
    `and unpadded; every line is injected into the character's cognition. Keep it under ${MAX_SYNTHESIS_CHARS} characters.`,
    "",
    "Respond with ONLY the index itself — no preamble, no headers naming this task, no code fences.",
    "Do NOT use any tools and do NOT write any files; your reply is saved verbatim to SYNTHESIS.md.",
  ].join("\n")
}

/** A turn produced no usable content if it timed out or returned only whitespace. */
const isBlankTurn = (r: { output: string; timedOut: boolean }): boolean =>
  r.timedOut || r.output.trim().length === 0

/**
 * Belt-and-braces fence stripping: the prompt forbids code fences, but the raw
 * turn output is written verbatim into SYNTHESIS.md and injected into every
 * future orient/decide prompt — a stray wrapper fence would pollute cognition
 * forever. If the WHOLE trimmed output is wrapped in one ``` fence (with or
 * without a language tag on the opening line), unwrap it. Anchored at both ends,
 * so interior fences — prose that merely CONTAINS a fenced block, or an interior
 * fence inside the unwrapped body — are never touched. (growth-store's tolerant
 * JSON extractors have their own fence fallback inline; there is no shared
 * prose-unwrap util to reuse.)
 */
export function unwrapWholeFence(text: string): string {
  const t = text.trim()
  const m = t.match(/^```[^\n]*\n([\s\S]*?)\n?```$/)
  return m ? m[1].trim() : t
}

export const bootstrapSynthesis = {
  name: "synthesisBootstrap" as const,
  execute: (
    input: BootstrapInput,
  ): Effect.Effect<
    BootstrapOutput,
    never,
    CharacterFs | CharacterLog | CommandExecutor.CommandExecutor | OAuthToken
  > =>
    Effect.gen(function* () {
      const charFs = yield* CharacterFs

      // 1. GATE ON FILE CONTENT (idempotent across sessions; never overwrites).
      //    A whitespace-only file counts as empty. Never-fail read.
      const existing = yield* charFs.readSynthesis(input.char).pipe(Effect.catchAll(() => Effect.succeed("")))
      if (existing.trim().length > 0) {
        return { bootstrapped: false }
      }

      // 2. Gather the bedrock identity (each read never-fails / degrades to empty),
      //    bounded in code before it reaches the model.
      const background = yield* charFs.readBackground(input.char).pipe(Effect.catchAll(() => Effect.succeed("")))
      const values = yield* charFs.readValues(input.char).pipe(Effect.catchAll(() => Effect.succeed("")))
      const diary = yield* charFs.readDiary(input.char).pipe(Effect.catchAll(() => Effect.succeed("")))

      const prompt = buildBootstrapPrompt({
        background: truncate(background, BOOTSTRAP_IDENTITY_MAX),
        values: truncate(values, BOOTSTRAP_IDENTITY_MAX),
        diary: truncate(diary, BOOTSTRAP_DIARY_MAX),
      })

      // 3. ONE smart-tier brain turn, tool-less (a bootstrap is a summarization —
      //    smart, not macro's reasoning). A blank/timed-out/errored turn keeps
      //    NOTHING — never-fail, exactly like dream/retrospect/macro.
      const model = resolveModel(input.models, "synthesisBootstrap", "smart")
      const turn = yield* runTurn({
        containerId: input.containerId,
        playerName: input.playerName,
        char: input.char,
        prompt,
        systemPrompt: "",
        model,
        timeoutMs: REFLECTION_TURN_TIMEOUT_MS,
        role: "brain",
        noTools: true,
        addDirs: input.addDirs,
        env: input.env,
      }).pipe(
        Effect.map((r) =>
          isBlankTurn(r)
            ? { ok: false as const, reason: r.timedOut ? "turn timed out (no output)" : "turn returned empty output" }
            : { ok: true as const, text: r.output },
        ),
        Effect.catchAll((e) => Effect.succeed({ ok: false as const, reason: String(e) })),
      )

      if (!turn.ok) {
        yield* logError(
          input.char.name,
          "hippocampus",
          `synthesis_bootstrap_failed: ${turn.reason} — no memory index written, placeholder kept`,
        ).pipe(Effect.catchAll(() => Effect.void))
        return { bootstrapped: false }
      }

      // 4. Unwrap a whole-output wrapper fence (belt-and-braces; interior fences
      //    untouched), then write through macro's shared bounded clamp (reuses
      //    MAX_SYNTHESIS_CHARS). Over-bound → discarded (nothing written). An
      //    output that unwraps to nothing (a bare empty fence) is treated as a
      //    blank turn — never a partial/empty file.
      const text = unwrapWholeFence(turn.text)
      if (text.length === 0) {
        yield* logError(
          input.char.name,
          "hippocampus",
          "synthesis_bootstrap_failed: turn output was an empty code fence — no memory index written, placeholder kept",
        ).pipe(Effect.catchAll(() => Effect.void))
        return { bootstrapped: false }
      }
      const bootstrapped = yield* writeSynthesisBounded(input.char, text, "synthesis_bootstrap")
      return { bootstrapped }
    }),
}
