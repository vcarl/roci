import * as path from "node:path"
import { readFileSync } from "node:fs"
import { Layer } from "effect"
import type {
  PromptBuilder,
  TaskPromptContext,
  ChannelEventContext,
} from "@roci/core/core/prompt-builder.js"
import { PromptBuilderTag } from "@roci/core/core/prompt-builder.js"
import { stripFrontmatter } from "@roci/core/core/template.js"

// ── Template loading ────────────────────────────────────────

const PROMPTS_DIR = path.join(import.meta.dirname, "prompts")

// ── Prompt builder ──────────────────────────────────────────

const makePromptBuilder = (): Omit<PromptBuilder, "systemPrompt"> => ({
  taskPrompt(ctx: TaskPromptContext): string {
    const sections: string[] = []

    sections.push(`# Task\n\n${ctx.summary.headline}`)

    if (ctx.summary.sections.length > 0) {
      sections.push(ctx.summary.sections.map(s => `## ${s.heading}\n\n${s.body}`).join("\n\n"))
    }

    if (ctx.diary) {
      sections.push(`## Your Recent Diary\n\n${ctx.diary.slice(-2000)}`)
    }

    if (ctx.background) {
      sections.push(`## Background\n\n${ctx.background}`)
    }

    if (ctx.values) {
      sections.push(`## Your Values\n\n${ctx.values}`)
    }

    sections.push([
      "## Instructions",
      "",
      "You are playing SpaceMolt, a space MMO. Take actions in the game to pursue your goals.",
      "- Use the available game CLI tools to attack, build, trade, or explore",
      "- Use the `Agent` tool to plan complex multi-step sequences",
      "- You will receive game state updates every 30 seconds",
      "- When you have completed your planned actions for this session, call the `terminate` tool",
    ].join("\n"))

    return sections.join("\n\n")
  },

  channelEvent(ctx: ChannelEventContext): string {
    const parts: string[] = [`## Game Update (tick ${ctx.tickNumber})\n\n${ctx.summary.headline}`]

    if (ctx.stateDiff && ctx.stateDiff.trim()) {
      parts.push(`### Changes\n\n${ctx.stateDiff}`)
    }

    if (ctx.softAlerts && ctx.softAlerts.length > 0) {
      parts.push(`### Alerts\n\n${ctx.softAlerts.map(a => `- ${a.message}`).join("\n")}`)
    }

    if (ctx.summary.sections.length > 0) {
      parts.push(ctx.summary.sections.map(s => `### ${s.heading}\n\n${s.body}`).join("\n\n"))
    }

    return parts.join("\n\n")
  },
})

// ── Layer ────────────────────────────────────────────────────

function loadTemplateSync(filePath: string): string {
  return stripFrontmatter(readFileSync(filePath, "utf-8"))
}

/** Layer providing the SpaceMolt prompt builder. */
export const SpaceMoltPromptBuilderLive = Layer.succeed(
  PromptBuilderTag,
  (() => {
    const inGameClaudeMd = loadTemplateSync(path.join(PROMPTS_DIR, "in-game-claude.md"))
    return {
      ...makePromptBuilder(),
      systemPrompt: (_mode: string, _task: string) => inGameClaudeMd,
    }
  })(),
)
