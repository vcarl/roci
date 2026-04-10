import * as path from "node:path"
import { readFileSync, readdirSync } from "node:fs"
import { Layer } from "effect"
import type {
  PromptBuilder,
  TaskPromptContext,
  ChannelEventContext,
} from "@roci/core/core/prompt-builder.js"
import { PromptBuilderTag } from "@roci/core/core/prompt-builder.js"
import type { BrainMode } from "@roci/core/core/types.js"
import { parseFrontmatter } from "@roci/core/core/template.js"

// ── Load procedure + prompt templates at startup ─────────────

interface LoadedTemplate {
  name: string
  description: string
  template: string
}

function loadTemplatesFromDir(dirPath: string): Map<string, LoadedTemplate> {
  const templates = new Map<string, LoadedTemplate>()
  let entries: string[]
  try { entries = readdirSync(dirPath) } catch { return templates }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue
    const filePath = path.join(dirPath, entry)
    const raw = readFileSync(filePath, "utf-8")
    const { meta, body } = parseFrontmatter(raw)
    const name = (meta.name as string) ?? entry.replace(/\.md$/, "")
    templates.set(name, {
      name,
      description: (meta.description as string) ?? "",
      template: body,
    })
  }
  return templates
}

const DOMAIN_DIR = path.resolve(import.meta.dirname, ".")
const procedureTemplates = loadTemplatesFromDir(path.join(DOMAIN_DIR, "procedures"))

// ── System prompts by mode ───────────────────────────────────

const SYSTEM_PROMPT_PREAMBLE = `You are a subagent — a worker dispatched by a planning brain to complete a specific task. You report your findings and work back to the brain. You do NOT interact with the outside world.

At the end of every task, report your findings clearly and completely. The brain will decide what actions to take based on your report.`

const REPO_LAYOUT = `## Repository Layout

\`\`\`
/work/repos/<owner>--<repo>/                    # shared clone (on main, read-only)
/work/players/<you>/worktrees/<owner>--<repo>/   # your worktrees per feature branch
\`\`\`

**Do NOT** modify the shared clone — always use a worktree for changes.`

function systemPromptReadOnly(_task: string): string {
  return `# GitHub Subagent — Read-Only Mode

${SYSTEM_PROMPT_PREAMBLE}

## Capabilities

You can **read** GitHub data and local files. You cannot modify anything.

**Allowed:**
- \`gh issue list\`, \`gh issue view <number>\`
- \`gh pr list\`, \`gh pr view <number>\`, \`gh pr diff <number>\`, \`gh pr checks <number>\`
- \`gh run list\`, \`gh run view <id>\`, \`gh run view <id> --log-failed\`
- \`cat\`, \`ls\`, \`find\`, \`grep\`, \`head\`, \`tail\` — read files
- \`git log\`, \`git diff\`, \`git status\`, \`git branch\`

**Forbidden:**
- Any \`gh\` command that creates, edits, comments, reviews, or merges
- \`git commit\`, \`git push\`, or any write operation
- Creating, modifying, or deleting files

${REPO_LAYOUT}`
}

function systemPromptTriage(_task: string): string {
  return `# GitHub Subagent — Triage Mode

${SYSTEM_PROMPT_PREAMBLE}

## Capabilities

You can **read** GitHub issues and PRs. You **cannot** label, comment, edit, or close them — only report your triage recommendations.

**Allowed:**
- \`gh issue list\`, \`gh issue view <number>\`
- \`gh pr list\`, \`gh pr view <number>\`, \`gh pr diff <number>\`
- \`gh run list\`, \`gh run view <id>\`, \`gh run view <id> --log-failed\`
- \`cat\`, \`ls\`, \`find\`, \`grep\` — read files for context
- \`git log\`, \`git diff\`

**Forbidden:**
- \`gh issue edit\`, \`gh issue comment\`, \`gh issue close\`
- \`gh pr review\`, \`gh pr comment\`, \`gh pr merge\`, \`gh pr create\`
- \`git push\`
- Any command that modifies GitHub state

${REPO_LAYOUT}`
}

function systemPromptFeature(_task: string): string {
  return `# GitHub Subagent — Feature Mode

${SYSTEM_PROMPT_PREAMBLE}

## Capabilities

You can **read** GitHub data, **write code locally**, and **commit locally**. You cannot push, create PRs, or interact with GitHub.

**Allowed for reading:**
- \`gh issue list\`, \`gh issue view <number>\`
- \`gh pr list\`, \`gh pr view <number>\`, \`gh pr diff <number>\`
- \`gh run list\`, \`gh run view <id>\`, \`gh run view <id> --log-failed\`
- \`cat\`, \`ls\`, \`find\`, \`grep\` — read files

**Allowed for local work:**
- \`git fetch\`, \`git checkout\`, \`git branch\`, \`git log\`, \`git diff\`, \`git status\`
- \`git worktree add/list/remove\` — manage feature branch worktrees
- \`git add\`, \`git commit\` — stage and commit locally
- Creating, editing, and deleting local files
- Running tests, linters, build tools

**Forbidden:**
- \`git push\` (any form)
- \`gh pr create\`, \`gh pr comment\`, \`gh pr review\`, \`gh pr merge\`
- \`gh issue edit\`, \`gh issue comment\`
- Any command that sends data to GitHub

${REPO_LAYOUT}

## Commit Style

All commits are authored by "Claude <noreply@anthropic.com>". Sign off with your character name:

\`\`\`
<summary>

<description>

Signed-off-by: <your name>
\`\`\`

## Workflow

1. \`cd /work/repos/<owner>--<repo> && git fetch origin\`
2. \`git worktree add /work/players/<you>/worktrees/<owner>--<repo>/<branch> -b <branch> origin/main\`
3. \`cd\` to the new worktree directory
4. Make changes, run tests, commit with clear messages
5. Report the branch name and worktree path — the brain will handle pushing and PR creation`
}

function systemPromptReview(_task: string): string {
  return `# GitHub Subagent — Review Mode

${SYSTEM_PROMPT_PREAMBLE}

## Capabilities

You can **read** PRs, diffs, and code. You cannot submit reviews, comment, approve, or request changes — only report your analysis.

**Allowed:**
- \`gh pr view <number>\`, \`gh pr diff <number>\`, \`gh pr checks <number>\`
- \`gh pr list\`
- \`gh issue view <number>\` — for context on linked issues
- \`gh run list\`, \`gh run view <id>\`, \`gh run view <id> --log-failed\`
- \`cat\`, \`ls\`, \`find\`, \`grep\` — read files for context
- \`git log\`, \`git diff\`, \`git checkout\` — inspect code locally

**Forbidden:**
- \`gh pr review\`, \`gh pr comment\`, \`gh pr merge\`, \`gh pr close\`, \`gh pr ready\`
- \`gh issue edit\`, \`gh issue comment\`
- \`git push\`, \`git commit\`
- Any command that modifies GitHub state or local files

${REPO_LAYOUT}`
}

function systemPromptDiary(_task: string): string {
  return `# GitHub Subagent — Diary Mode

${SYSTEM_PROMPT_PREAMBLE}

## Capabilities

You can **read and write your diary file** (\`./me/DIARY.md\`). You cannot interact with GitHub or modify repository files.

**Allowed:**
- Reading \`./me/DIARY.md\` and other files in \`./me/\`
- Writing to \`./me/DIARY.md\` — append to existing content, do not replace it

**Forbidden:**
- Any \`gh\` command
- Any \`git\` command
- Modifying files outside \`./me/\``
}

const SYSTEM_PROMPT_BY_MODE: Record<string, (task: string) => string> = {
  select: systemPromptReadOnly,
  triage: systemPromptTriage,
  feature: systemPromptFeature,
  review: systemPromptReview,
}

/** Task-level overrides that take precedence over mode. */
const SYSTEM_PROMPT_BY_TASK: Record<string, (task: string) => string> = {
  diary: systemPromptDiary,
  investigate: systemPromptReadOnly,
  investigate_ci: systemPromptReadOnly,
}

// ── Prompt builder implementation ───────────────────────────

const gitHubPromptBuilder: PromptBuilder = {
  systemPrompt(mode: BrainMode, task: string): string {
    const promptFn = SYSTEM_PROMPT_BY_TASK[task] ?? SYSTEM_PROMPT_BY_MODE[mode] ?? SYSTEM_PROMPT_BY_MODE.select
    return promptFn(task)
  },

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
      "Work on the repositories assigned to you. Review open PRs, triage issues, implement improvements, and keep the codebase healthy.",
      "- Use the `Agent` tool to spawn subagents for focused tasks (implement a feature, review a PR, etc.)",
      "- You will receive state updates every 30 seconds via channel events",
      "- When you have completed meaningful work or nothing actionable remains, call the `terminate` tool with a summary",
    ].join("\n"))

    return sections.join("\n\n")
  },

  channelEvent(ctx: ChannelEventContext): string {
    const parts: string[] = [`## State Update (tick ${ctx.tickNumber})\n\n${ctx.summary.headline}`]

    if (ctx.stateDiff && ctx.stateDiff.trim()) {
      parts.push(`### Changes Since Last Update\n\n${ctx.stateDiff}`)
    }

    if (ctx.softAlerts && ctx.softAlerts.length > 0) {
      parts.push(`### Alerts\n\n${ctx.softAlerts.map(a => `- ${a.message}`).join("\n")}`)
    }

    if (ctx.summary.sections.length > 0) {
      parts.push(ctx.summary.sections.map(s => `### ${s.heading}\n\n${s.body}`).join("\n\n"))
    }

    return parts.join("\n\n")
  },
}

/** List of valid procedures (excluding "select") for plan parsing. */
export const validProcedures: string[] = Array.from(procedureTemplates.keys()).filter(n => n !== "select")

/** Layer providing the GitHub prompt builder. */
export const GitHubPromptBuilderLive = Layer.succeed(PromptBuilderTag, gitHubPromptBuilder)
