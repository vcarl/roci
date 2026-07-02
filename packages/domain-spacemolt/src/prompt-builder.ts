import * as path from "node:path"
import { readFileSync } from "node:fs"
import { Layer } from "effect"
import { PromptBuilderTag } from "@roci/core/core/prompt-builder.js"
import { stripFrontmatter, renderTemplate } from "@roci/core/core/template.js"

// ── Template loading ────────────────────────────────────────

const PROMPTS_DIR = path.join(import.meta.dirname, "prompts")

// ── Layer ────────────────────────────────────────────────────

function loadTemplateSync(filePath: string): string {
  return stripFrontmatter(readFileSync(filePath, "utf-8"))
}

/** Layer providing the SpaceMolt prompt builder. */
export const SpaceMoltPromptBuilderLive = Layer.succeed(
  PromptBuilderTag,
  (() => {
    const inGameClaudeMd = loadTemplateSync(path.join(PROMPTS_DIR, "in-game-claude.md"))
    const discoveryRubric = renderTemplate(
      loadTemplateSync(path.join(PROMPTS_DIR, "discovery-rubric.md")),
      {
        primaryTools: "`spacemolt` CLI",
        whereDocsLive: "in-game docs and the forum",
        statusCommands: "the game-state command",
        pathExamples: "build a fleet, gather resources, combat, or alliance/social play",
      },
    )
    const inGameWithDiscovery = `${inGameClaudeMd}\n\n${discoveryRubric}`
    return {
      systemPrompt: (_mode: string, _task: string) => inGameWithDiscovery,
    }
  })(),
)
