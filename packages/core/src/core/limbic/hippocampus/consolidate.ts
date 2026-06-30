import * as path from "node:path"
import { Effect } from "effect"
import { CharacterFs, type CharacterConfig } from "../../../services/CharacterFs.js"
import { CharacterLog } from "../../../logging/log-writer.js"
import { eventBase } from "../../../logging/events.js"
import { loadTemplate, renderTemplate } from "../../template.js"
import { runTurn } from "../hypothalamus/process-runner.js"
import type { ModelConfig } from "../../model-config.js"
import { resolveModel } from "../../model-config.js"

/** Count lines, consistent with the line-based diary sizing used by the cull. */
const lineCount = (s: string) => s.split("\n").length

export interface ConsolidateInput {
  char: CharacterConfig
  containerId: string
  playerName: string
  addDirs?: string[]
  env?: Record<string, string>
  models: ModelConfig
}

export interface ConsolidateOutput {
  diaryConsolidated: boolean
}

/** Path to core's shared skill prompts (src/skills, copied to dist/skills). */
const SKILLS_DIR = path.resolve(import.meta.dirname, "../../../skills")

/**
 * Consolidate pass (per cycle, all domains): rewrite the current DIARY.md — which
 * holds the prior diary plus this session's raw per-step appends — into coherent
 * narrative entries. Operates on the current diary content only (no dependency on
 * domain-specific session logs), which is why it generalizes the old spacemolt
 * dinner pass into core. May grow the file; the cull (dream) reins it in next.
 */
export const consolidate = {
  name: "consolidate" as const,
  execute: (input: ConsolidateInput) =>
    Effect.gen(function* () {
      const charFs = yield* CharacterFs
      const log = yield* CharacterLog

      yield* log.emit(input.char, {
        ...eventBase(input.char.name, "orchestrator", "consolidate"),
        kind: "text",
        text: "consolidate_start",
      })

      const diary = yield* charFs.readDiary(input.char)
      const values = yield* charFs.readValues(input.char)

      const template = yield* loadTemplate(path.join(SKILLS_DIR, "consolidate.md"))
      const prompt = renderTemplate(template, { DIARY: diary, VALUES: values })

      const result = yield* runTurn({
        containerId: input.containerId,
        playerName: input.playerName,
        char: input.char,
        prompt,
        systemPrompt: "",
        // Reuse the model role the former dinner pass used so behavior is preserved.
        model: resolveModel(input.models, "dinner", "smart"),
        timeoutMs: 120_000,
        role: "brain",
        noTools: true,
        addDirs: input.addDirs,
        env: input.env,
      })

      yield* charFs.writeDiary(input.char, result.output)

      yield* log.emit(input.char, {
        ...eventBase(input.char.name, "orchestrator", "consolidate"),
        kind: "text",
        text: `consolidate_complete (${lineCount(diary)} -> ${lineCount(result.output)} lines)`,
      })

      return { diaryConsolidated: true } as ConsolidateOutput
    }),
}
