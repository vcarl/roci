import * as path from "node:path"
import { readFileSync, readdirSync } from "node:fs"
import { Layer } from "effect"
import type {
  PromptBuilder,
  PlanPromptContext,
  InterruptPromptContext,
  EvaluatePromptContext,
  SubagentPromptContext,
  PlannedActionBrainPromptContext,
  TaskPromptContext,
  ChannelEventContext,
} from "@roci/core/core/prompt-builder.js"
import { PromptBuilderTag } from "@roci/core/core/prompt-builder.js"
import type { GitHubState } from "./types.js"
import type { BrainMode } from "@roci/core/core/types.js"
import { parseFrontmatter, renderTemplate } from "@roci/core/core/template.js"
import {
  buildTimingSection,
  renderIdentitySection,
  renderProcedureContext,
  subagentCommon,
  renderReposSummary,
} from "./prompt-helpers.js"

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
const promptTemplates = loadTemplatesFromDir(path.join(DOMAIN_DIR, "prompts"))

// ── Select procedure: build the {{instructions}} and {{investigationSection}} blocks ──

function buildSelectInstructions(ctx: PlanPromptContext): { investigationSection: string; instructions: string } {
  const state = ctx.state as GitHubState

  if (!ctx.investigationReport) {
    return {
      investigationSection: "",
      instructions: `## Instructions

You need to investigate before committing to a plan. Produce a 1-step plan with task "investigate" that gathers the context you need to decide what to do next.

The investigation goal should describe what to look into — e.g. "Read bodies of issues #12, #15, #18 and check CI status for repo X". Be specific about what information you need.

Each tick is ${ctx.tickIntervalSec} seconds.
${buildTimingSection(ctx)}
Respond with JSON:
\`\`\`json
{
  "reasoning": "What you need to investigate and why",
  "steps": [
    {
      "task": "investigate",
      "goal": "Specific things to read/check",
      "successCondition": "Investigation findings reported",
      "timeoutTicks": 5
    }
  ]
}
\`\`\``,
    }
  }

  // Build available procedures from loaded templates (excluding "select")
  const availableProcs = Array.from(procedureTemplates.values())
    .filter(p => p.name !== "select")
    .map(p => `- **${p.name}**: ${p.description}`)
    .join("\n")

  return {
    investigationSection: `## Investigation Report\n${ctx.investigationReport.slice(-3000)}`,
    instructions: `## Available Procedures

${availableProcs}

## Instructions

You MUST pick a procedure now. Do NOT produce another "investigate" step — investigation is complete. The "procedure" field is REQUIRED.

Based on your investigation, pick ONE procedure. Scope to specific items. Prefer focused over broad.

Prioritize: CI failures > untriaged issues > pending reviews > new work.

Each tick is ${ctx.tickIntervalSec} seconds.
${buildTimingSection(ctx)}
Respond with JSON (the "procedure" field is REQUIRED):
\`\`\`json
{
  "procedure": "${Array.from(procedureTemplates.keys()).filter(n => n !== "select").join("|")}",
  "targets": ["#12", "#15"],
  "reasoning": "Why this procedure and these targets",
  "steps": [
    {
      "task": "triage|code|review|investigate_ci",
      "goal": "Specific action on specific item — e.g. 'Label and comment on #12'",
      "successCondition": "How to verify completion",
      "timeoutTicks": 5
    }
  ]
}
\`\`\``,
  }
}

// ── Plan prompt (template-based for non-select, inline for select) ──

function planPrompt(ctx: PlanPromptContext): string {
  const state = ctx.state as GitHubState

  const template = procedureTemplates.get(ctx.mode)
  if (!template) {
    // Fallback to select if procedure not found
    return planPrompt({ ...ctx, mode: "select" })
  }

  const failureSection = ctx.previousFailure
    ? `\n## Previous Plan Failed\n${ctx.previousFailure}\n`
    : ""

  const repoCount = String(state.repos.length)
  const repoPlural = state.repos.length === 1 ? "y" : "ies"

  // Build stateSummary and briefing from summary.sections
  const stateSummary = ctx.summary.sections
    .map(s => `## ${s.heading}\n${s.body}`)
    .join("\n\n")
  const briefing = `${ctx.summary.headline}\n\n${stateSummary}`

  const baseVars: Record<string, string> = {
    repoCount,
    repoPlural,
    stateSummary,
    briefing,
    identitySection: renderIdentitySection(ctx),
    timingSection: buildTimingSection(ctx),
    tickIntervalSec: String(ctx.tickIntervalSec),
    failureSection,
    diary: ctx.diary.slice(-2000),
    procedureContext: renderProcedureContext(ctx),
  }

  if (ctx.mode === "select") {
    const { investigationSection, instructions } = buildSelectInstructions(ctx)
    baseVars.investigationSection = investigationSection
    baseVars.instructions = instructions
  }

  return renderTemplate(template.template, baseVars)
}

// ── Subagent prompts by task type ───────────────────────────

function subagentInvestigate(ctx: SubagentPromptContext): string {
  return `You are investigating repository state. This is a **READ-ONLY** task — do not create, modify, or delete any files.

${subagentCommon(ctx)}

## Instructions

Gather information and report back. The brain will decide what to do next based on your report.

Report your findings in a structured format:
- For each issue: number, title, key details from the body, suggested priority/labels
- For each PR: number, title, diff summary, test status, review readiness
- For CI: failure details, root cause if identifiable

Be thorough but focused on what was requested in the goal.`
}

function subagentTriage(ctx: SubagentPromptContext): string {
  return `You are triaging GitHub issues.

${subagentCommon(ctx)}

**Do NOT label, comment on, or modify issues.** The brain will act on your report.

## Instructions

For each issue in your goal:
1. Read the issue body carefully with \`gh issue view <number>\`
2. Analyze the issue: what type is it (bug/feature/docs)? What priority? What area?
3. Check if related issues or PRs exist

Report your triage recommendations in a structured format:
- Issue number and title
- Recommended labels and why
- Recommended priority and why
- Any related issues/PRs
- Suggested next action (e.g. "needs reproduction steps", "ready for implementation")`
}

function subagentCode(ctx: SubagentPromptContext): string {
  return `You are implementing code changes.

${subagentCommon(ctx)}

## Git Worktree Workflow

Each repo has a **shared clone** (on main) and your **worktree directory** for feature branches.

**To start coding on a repo** (e.g. \`/work/repos/owner--repo\`):
\`\`\`bash
cd /work/repos/owner--repo
git fetch origin
git worktree add /work/players/YOUR_NAME/worktrees/owner--repo/my-feature -b my-feature origin/main
cd /work/players/YOUR_NAME/worktrees/owner--repo/my-feature
# ... make changes, commit ...
\`\`\`

**Do NOT modify the shared clone directly** — always use a worktree for changes.

**Do NOT push or create PRs.** Commit locally; the brain will handle publishing.

## Instructions

1. Create a feature branch and worktree
2. Make focused, small changes
3. Run tests if available
4. Commit with clear messages and your sign-off

Report what you changed, test results, the branch name, and the worktree path.`
}

function subagentReview(ctx: SubagentPromptContext): string {
  return `You are reviewing a pull request.

${subagentCommon(ctx)}

## Instructions

1. Read the PR description: \`gh pr view <number>\`
2. Read the diff carefully: \`gh pr diff <number>\`
3. Check CI status: \`gh pr checks <number>\`
4. If needed, check out the code locally to understand context
5. Evaluate:
   - Correctness: Does the code do what it claims?
   - Edge cases: Are boundary conditions handled?
   - Style: Is the code clean and consistent?
   - Tests: Are changes tested adequately?

**Do NOT submit a review or comment on the PR.** The brain will act on your report.

Report your findings in detail:
- Overall verdict: approve, request changes, or needs discussion
- For each concern: file path, line number, what the issue is, and suggested fix
- Positive observations worth calling out
- Summary of what the PR does and whether it achieves its stated goal`
}

function subagentInvestigateCi(ctx: SubagentPromptContext): string {
  return `You are investigating CI failures.

${subagentCommon(ctx)}

## Instructions

1. List recent CI runs: \`gh run list\`
2. View failed run details: \`gh run view <id> --log-failed\`
3. Identify the root cause of the failure
4. Check if it's a flaky test, a real bug, or a configuration issue

Report:
- Which run failed and on which branch
- The specific error/failure
- Root cause analysis
- Suggested fix`
}

function subagentDiary(ctx: SubagentPromptContext): string {
  return `You are updating your diary.

${subagentCommon(ctx)}

## Instructions

Update ./me/DIARY.md with a brief entry about what you accomplished, what you learned, and what to focus on next. Append to the existing content, don't replace it.`
}

function subagentDefault(ctx: SubagentPromptContext): string {
  const state = ctx.state as GitHubState

  return `You are working across ${state.repos.length} repositor${state.repos.length === 1 ? "y" : "ies"}.

${subagentCommon(ctx)}

## Tools
Use \`gh\` for reading GitHub state and \`git\` for local repository operations.

**Do NOT** run any command that publishes, comments, reviews, or pushes. Read and work locally only.

## Git Worktree Workflow
Each repo has a **shared clone** (on main, read-only) and your **worktree directory** for feature branches.

Complete your task and report your findings.`
}

const SUBAGENT_PROMPT_BY_TASK: Record<string, (ctx: SubagentPromptContext) => string> = {
  investigate: subagentInvestigate,
  triage: subagentTriage,
  code: subagentCode,
  review: subagentReview,
  investigate_ci: subagentInvestigateCi,
  diary: subagentDiary,
}

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

// ── Evaluate + Interrupt prompts (template-based) ───────────

function evaluatePrompt(ctx: EvaluatePromptContext): string {
  const template = promptTemplates.get("evaluate")
  if (!template) {
    throw new Error("evaluate.md prompt template not found")
  }

  const secondsConsumed = Math.round(ctx.ticksConsumed * ctx.tickIntervalSec)
  const secondsBudgeted = Math.round(ctx.ticksBudgeted * ctx.tickIntervalSec)
  const overrunDelta = ctx.ticksConsumed - ctx.ticksBudgeted
  const overrunWarning = overrunDelta > 0
    ? `\nWARNING: exceeded tick budget by ${overrunDelta} ticks.`
    : ""

  const modeHint = ctx.mode === "select"
    ? "\nThis was an investigation step. If findings are sufficient, mark complete so the brain can pick a procedure next."
    : ""

  return renderTemplate(template.template, {
    goal: ctx.step.goal,
    successCondition: ctx.step.successCondition,
    subagentReport: ctx.subagentReport.slice(-2000),
    stateDiff: ctx.stateDiff,
    conditionResult: ctx.conditionCheck.complete ? "PASS" : "FAIL",
    conditionReason: ctx.conditionCheck.reason,
    ticksConsumed: String(ctx.ticksConsumed),
    ticksBudgeted: String(ctx.ticksBudgeted),
    secondsConsumed: String(secondsConsumed),
    secondsBudgeted: String(secondsBudgeted),
    overrunWarning,
    modeHint,
  })
}

function interruptPrompt(ctx: InterruptPromptContext): string {
  const template = promptTemplates.get("interrupt")
  if (!template) {
    throw new Error("interrupt.md prompt template not found")
  }

  const currentPlanSummary = ctx.currentPlan
    ? `Current plan:\n${ctx.currentPlan.steps.map((s, i) => `${i + 1}. [${s.task}] ${s.goal}`).join("\n")}`
    : "No active plan."

  const modeContext = ctx.mode !== "select"
    ? `\n## Interrupted Context\nYou were in **${ctx.mode}** mode${ctx.procedureTargets?.length ? ` targeting ${ctx.procedureTargets.join(", ")}` : ""}. A critical interrupt occurred. You are being reset to **select** mode — investigate and pick a new procedure.\n`
    : ""

  const alertLines = ctx.alerts.map((a) =>
    `[${a.priority}] ${a.message} (suggested: ${a.suggestedAction ?? "none"})`
  ).join("\n")

  const briefing = `${ctx.summary.headline}\n\n${ctx.summary.sections.map(s => `## ${s.heading}\n${s.body}`).join("\n\n")}`

  return renderTemplate(template.template, {
    alertLines,
    modeContext,
    briefing,
    currentPlanSummary,
    background: ctx.background.slice(0, 1000),
  })
}

// ── Prompt builder implementation ───────────────────────────

const gitHubPromptBuilder: PromptBuilder = {
  planPrompt,
  interruptPrompt,
  evaluatePrompt,

  subagentPrompt(ctx: SubagentPromptContext): string {
    const promptFn = SUBAGENT_PROMPT_BY_TASK[ctx.step.task] ?? subagentDefault
    return promptFn(ctx)
  },

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

  brainPrompt(ctx: PlannedActionBrainPromptContext): string {
    const stateSummary = ctx.summary.sections
      .map(s => `## ${s.heading}\n${s.body}`)
      .join("\n\n")

    const parts = [`# Current State\n\n${stateSummary}`]

    if (ctx.background) {
      parts.push(`\n\n# Your Identity\n\n${ctx.background}`)
    }
    if (ctx.values) {
      parts.push(`\n\n# Your Values\n\n${ctx.values}`)
    }
    parts.push(`\n\n# Diary\n\n${ctx.diary.slice(-3000)}`)
    parts.push(`\n\n# Cycle Progress\n\nCycle ${ctx.cycleNumber} of ${ctx.maxCycles}`)

    if (ctx.softAlerts.length > 0) {
      const alertLines = ctx.softAlerts
        .map(a => `- [${a.priority}] ${a.message}`)
        .join("\n")
      parts.push(`\n\n# Alerts\n\n${alertLines}`)
    }

    if (ctx.stateDiff) {
      parts.push(`\n\n# Changes Since Last Cycle\n\n${ctx.stateDiff}`)
    }

    return parts.join("")
  },
}

/** List of valid procedures (excluding "select") for plan parsing. */
export const validProcedures: string[] = Array.from(procedureTemplates.keys()).filter(n => n !== "select")

/** Layer providing the GitHub prompt builder. */
export const GitHubPromptBuilderLive = Layer.succeed(PromptBuilderTag, gitHubPromptBuilder)
