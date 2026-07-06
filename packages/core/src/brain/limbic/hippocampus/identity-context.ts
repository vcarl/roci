import { Effect } from "effect"
import type { CharacterConfig } from "../../../services/CharacterFs.js"
import { CharacterFs } from "../../../services/CharacterFs.js"
import { CharacterLog, logError } from "../../../logging/log-writer.js"
import { MemoryGateway, orientQuery } from "./memory/memory-gateway.js"
import { readWm, renderOpenTodoTree } from "../wm/wm-store.js"

/**
 * IDENTITY / CONTEXT INJECTION — the single seam.
 *
 * Three distinct mechanisms feed character context into a model prompt. Two of
 * them are body-side (a different layer) and are NOT touched here; this helper
 * owns exactly the first. The whole map lives here so the layering stays legible
 * and adding/removing a block is a one-place change:
 *
 *  1. Local-tier prompt vars (THIS helper). background, values, diary, the
 *     SYNTHESIS memory index, recalled long-term memories, and the working-memory
 *     todo tree are read once per escalation and rendered into the forebrain
 *     orient prompt (this layer's prompts/orient.md); the idle path threads the same recall/wm
 *     onward into the conscious tier's decide prompt (its prompts/decide.md). Assembled ONCE
 *     here so the loop's idle and steer paths share one seam, and every block
 *     that renders under a template header carries an honest empty-state
 *     placeholder (never a bare header); self-guarded blocks pass through raw.
 *  2. Body WM.md (NOT here). The same working-memory file is mounted into the
 *     opencode conscious session via its `instructions` file — a body-side
 *     mechanism owned by wm-store.ts (ensureWmFiles / re-render on mutate).
 *  3. Worn-skill body (NOT here). The decide-chosen skill's body is injected into
 *     the step task by formatStepTask — a body-side mechanism owned by
 *     brain/loop/state.ts.
 *
 * SYNTHESIS.md is the character's memory index, produced by the macro cycle (and
 * seeded by the bootstrap stage). This helper's only responsibility for it is that
 * its absence renders honestly as the `synthesis` placeholder rather than a blank
 * `### Memory Index (synthesis)` header.
 */

/** The assembled identity/context bundle handed to the orient (and decide) tiers. */
export interface IdentityContext {
  background: string
  values: string
  diary: string
  synthesis: string
  recalledMemories: string
  workingMemory: string
}

/**
 * Per-block empty-state placeholders. Short by design — they are rendered into
 * every orient/decide prompt consumed by small local models, so they must say
 * "empty, on purpose" in a few tokens without crowding the real context.
 * Decided ONCE here (not scattered across the templates).
 *
 * Two blocks are deliberately absent:
 *  - workingMemory: its placeholder ("(no open todos)") is owned by
 *    renderOpenTodoTree, the canonical wm renderer.
 *  - recalledMemories: formatRecall is self-guarding — it returns "" when there
 *    are no hits and builds its own "## You recall" header INSIDE the block,
 *    and orient.md renders {{recalledMemories}} with no surrounding header. An
 *    empty recall never produced a bare header; a placeholder would inject a
 *    stray floating line above "## Accumulated Events" on every cold start.
 */
export const IDENTITY_PLACEHOLDERS = {
  background: "(no background recorded yet)",
  values: "(no values recorded yet)",
  diary: "(no diary entries yet)",
  synthesis: "(no memory index yet)",
} as const

/** Non-empty (non-whitespace) source passes through byte-for-byte; empty → placeholder. */
const orPlaceholder = (raw: string, placeholder: string): string => (raw.trim() ? raw : placeholder)

export interface ReadIdentityContextArgs {
  char: CharacterConfig
  containerId: string
  accumulatedEvents: string[]
  emotionalWeight: string
}

/**
 * Read every identity/context source for a character ONCE and assemble the
 * bundle the orient tier renders (and the idle path threads into decide). This
 * is the single assembly seam shared by both loop paths (idle re-orient and
 * in-session steer), so the two never drift.
 *
 * Fail-loud reads: an identity-file read failure is logged as a structured
 * kind:"error" event (the model's loss of grounding must be diagnosable) and
 * then degrades to the empty string, which renders as that block's placeholder —
 * so a missing/failed source is never a silent blank header. The log write
 * itself is swallowed so logging can never crash the loop.
 */
export const readIdentityContext = (
  args: ReadIdentityContextArgs,
): Effect.Effect<IdentityContext, never, CharacterFs | MemoryGateway | CharacterLog> =>
  Effect.gen(function* () {
    const charFs = yield* CharacterFs
    const memory = yield* MemoryGateway
    const { char } = args

    const readOrEmpty = (label: string, read: Effect.Effect<string, unknown, never>) =>
      read.pipe(
        Effect.catchAll((e) =>
          logError(char.name, "cortex", `${label} read failed; using empty: ${e}`).pipe(
            Effect.catchAll(() => Effect.void),
            Effect.as(""),
          ),
        ),
      )

    const background = yield* readOrEmpty("background", charFs.readBackground(char))
    const values = yield* readOrEmpty("values", charFs.readValues(char))
    const diary = yield* readOrEmpty("diary", charFs.readDiary(char))
    const synthesis = yield* readOrEmpty("synthesis", charFs.readSynthesis(char))
    // Recalled long-term memories: deliberately passed through RAW (no
    // placeholder). formatRecall returns a self-contained block — "" when no
    // hits, else "\n\n## You recall\n- …" with its own header — and the
    // template renders it with no surrounding header, so an empty recall never
    // leaves a bare header. See the IDENTITY_PLACEHOLDERS doc above.
    const recalledMemories = yield* memory.recall(
      args.containerId,
      char,
      orientQuery(args.accumulatedEvents, args.emotionalWeight),
      { k: 2, label: "You recall", maxChars: 300 },
    )
    // Working memory: the capped, tree-rendered open todo list. renderOpenTodoTree
    // already yields "(no open todos)" when the list is empty, so its placeholder
    // lives with the wm renderer (not duplicated here).
    const workingMemory = renderOpenTodoTree(yield* readWm(char))

    return {
      background: orPlaceholder(background, IDENTITY_PLACEHOLDERS.background),
      values: orPlaceholder(values, IDENTITY_PLACEHOLDERS.values),
      diary: orPlaceholder(diary, IDENTITY_PLACEHOLDERS.diary),
      synthesis: orPlaceholder(synthesis, IDENTITY_PLACEHOLDERS.synthesis),
      recalledMemories,
      workingMemory,
    }
  })
