import * as path from "node:path"
import { readFileSync, readdirSync } from "node:fs"
import { Layer } from "effect"
import type { DomainBundle } from "@signal/core/core/domain-bundle.js"
import { SkillRegistryTag } from "@signal/core/core/skill.js"
import type { Skill } from "@signal/core/core/skill.js"
import { GitHubEventProcessorLive } from "./event-processor.js"
import { GitHubInterruptRegistryLive } from "./interrupts.js"
import { GitHubSituationClassifierLive } from "./situation-classifier.js"
import { GitHubStateRendererLive } from "./renderer.js"
import { GitHubPromptBuilderLive } from "./prompt-builder.js"
import { GitHubClientLive } from "./github-client.js"
import { parseFrontmatter } from "@signal/core/core/template.js"

// ── Load skills from .claude/skills/ at startup ─────────────

function loadSkillFiles(): Skill[] {
  const skillsDir = path.resolve(import.meta.dirname, ".claude/skills")
  let entries: string[]
  try { entries = readdirSync(skillsDir) } catch { return [] }

  const skills: Skill[] = []
  for (const entry of entries) {
    const skillPath = path.join(skillsDir, entry, "SKILL.md")
    let raw: string
    try { raw = readFileSync(skillPath, "utf-8") } catch { continue }

    const { meta, body } = parseFrontmatter(raw)
    skills.push({
      name: (meta.name as string) ?? entry,
      description: (meta.description as string) ?? "",
      instructions: body,
      checkCompletion: () => ({
        complete: false,
        reason: "No deterministic check — use your judgment based on state changes",
        matchedCondition: null,
        relevantState: {},
      }),
      defaultModel: (meta.model as "haiku" | "sonnet") ?? "haiku",
      defaultTimeoutTicks: (meta.timeoutTicks as number) ?? 10,
    })
  }
  return skills
}

const loadedSkills = loadSkillFiles()

const FileSkillRegistryLive = Layer.succeed(SkillRegistryTag, {
  skills: loadedSkills,
  getSkill: (name) => loadedSkills.find(s => s.name === name),
  taskList: () => loadedSkills.map(s => `- **${s.name}**: ${s.description}`).join("\n"),
  isStepComplete: () => ({
    complete: false,
    reason: "No deterministic check — use your judgment based on state changes",
    matchedCondition: null,
    relevantState: {},
  }),
})

/** All GitHub domain service layers bundled for the core state machine. */
export const gitHubDomainBundle: DomainBundle = Layer.mergeAll(
  GitHubPromptBuilderLive,
  GitHubEventProcessorLive,
  FileSkillRegistryLive,
  GitHubInterruptRegistryLive,
  GitHubSituationClassifierLive,
  GitHubStateRendererLive,
)

/** GitHub-specific service layer (GitHubClient) for the CLI's global service layer. */
export { GitHubClientLive }
