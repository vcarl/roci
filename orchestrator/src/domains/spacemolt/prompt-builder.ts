import { fileURLToPath } from "node:url"
import * as path from "node:path"
import { Effect, Layer } from "effect"
import type {
  PromptBuilder,
  PlanPromptContext,
} from "../../core/prompt-builder.js"
import { PromptBuilderTag } from "../../core/prompt-builder.js"
import type { GameState, Situation } from "./types.js"
import { snapshot } from "./state-renderer.js"
import { loadTemplate, renderTemplate } from "../../core/template.js"

// ── Template loading ────────────────────────────────────────

const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "prompts")

// ── Context assembly helpers ────────────────────────────────

const TASK_LIST = "mine|travel|sell|dock|undock|refuel|repair|combat|chat|explore"

const TOOL_DOCS = `The \`sm\` CLI is installed on your PATH. Run \`sm --help\` for all commands, or \`sm commands\` for a categorized reference.`

function buildStateSummary(state: GameState, situation: Situation): string {
  const { player, ship } = state
  const lines = [
    `Situation: ${situation.type}`,
    `Location: ${state.poi?.name && state.poi.id === player.current_poi ? state.poi.name : player.current_poi} in ${state.system?.name && state.system.id === player.current_system ? state.system.name : player.current_system}`,
    `Credits: ${player.credits}. Fuel: ${ship.fuel}/${ship.max_fuel}. Hull: ${ship.hull}/${ship.max_hull}.`,
    `Cargo: ${ship.cargo_used}/${ship.cargo_capacity}`,
  ]

  if (situation.alerts.length > 0) {
    lines.push("Alerts:")
    for (const a of situation.alerts) {
      lines.push(`  [${a.priority}] ${a.message}`)
    }
  }

  if (state.nearby.length > 0) {
    lines.push(`Nearby: ${state.nearby.map((p: { username: string }) => p.username).join(", ")}`)
  }

  return lines.join("\n")
}

function buildFailureSection(previousFailure?: string): string {
  if (!previousFailure) return ""
  return `\n## Previous Plan Failed\n${previousFailure}\n\nYour previous plan hit a problem. Account for this when making a new plan — you may need to retry the failed step, try a different approach, or adjust the overall strategy.\n`
}

function buildChatSection(recentChat?: Array<{ channel: string; sender: string; content: string }>): string {
  if (!recentChat || recentChat.length === 0) return ""
  return `\n## Recent Chat\n${recentChat.map((m) => `[${m.channel}] ${m.sender}: ${m.content}`).join("\n")}\n\nConsider whether any of these messages warrant a response or affect your plans.\n`
}

function buildTimingSection(stepTimingHistory?: PlanPromptContext["stepTimingHistory"]): string {
  if (!stepTimingHistory || stepTimingHistory.length === 0) return ""
  return `\n## Recent Step Outcomes\n${stepTimingHistory.map((h) => {
    let line = `[${h.task}] "${h.goal}" — ${h.ticksConsumed}/${h.ticksBudgeted} ticks${h.overrun ? " OVERRUN" : ""}`
    if (h.succeeded !== undefined) {
      line += ` -> ${h.succeeded ? "SUCCESS" : "FAILED"}`
      if (h.reason) line += `: ${h.reason}`
    }
    if (h.stateDiff && h.stateDiff !== "(no changes detected)" && h.stateDiff !== "(no before-state captured)") {
      line += `\n  State changes: ${h.stateDiff.split("\n").join(", ")}`
    }
    return line
  }).join("\n")}\n\nUse this data to set realistic timeoutTicks and learn from recent outcomes.\n`
}

function buildAdditionalSection(additionalContext?: string): string {
  if (!additionalContext) return ""
  return `\n## Additional Context\n${additionalContext}\n`
}

// ── Prompt builder ──────────────────────────────────────────

const makePromptBuilder = (templates: Record<string, string>): PromptBuilder => ({
  planPrompt(ctx) {
    return renderTemplate(templates.plan, {
      taskList: TASK_LIST,
      tickIntervalSec: String(ctx.tickIntervalSec),
      briefing: ctx.briefing,
      failureSection: buildFailureSection(ctx.previousFailure),
      chatSection: buildChatSection(ctx.recentChat),
      timingSection: buildTimingSection(ctx.stepTimingHistory),
      additionalSection: buildAdditionalSection(ctx.additionalContext),
      background: ctx.background,
      values: ctx.values,
      diary: ctx.diary.slice(-2000),
      situationType: (ctx.situation as Situation).type,
    })
  },

  interruptPrompt(ctx) {
    const currentPlanSummary = ctx.currentPlan
      ? `Current plan:\n${ctx.currentPlan.steps.map((s: { task: string; goal: string }, i: number) => `${i + 1}. [${s.task}] ${s.goal}`).join("\n")}`
      : "No active plan."

    return renderTemplate(templates.interrupt, {
      alerts: ctx.alerts.map((a) => `[${a.priority}] ${a.message} (suggested: ${a.suggestedAction ?? "none"})`).join("\n"),
      briefing: ctx.briefing,
      currentPlanSummary,
      background: ctx.background.slice(0, 1000),
    })
  },

  evaluatePrompt(ctx) {
    const stateSnapshot = snapshot(ctx.state as GameState)

    const secondsConsumed = Math.round(ctx.ticksConsumed * ctx.tickIntervalSec)
    const secondsBudgeted = Math.round(ctx.ticksBudgeted * ctx.tickIntervalSec)
    const overrunDelta = ctx.ticksConsumed - ctx.ticksBudgeted
    const timingLine = `Timing: consumed ${ctx.ticksConsumed} of ${ctx.ticksBudgeted} budgeted ticks (~${secondsConsumed}s of ~${secondsBudgeted}s).`
    const overrunWarning = overrunDelta > 0
      ? `\nWARNING: exceeded tick budget by ${overrunDelta} ticks. Factor this into your evaluation.`
      : ""
    const conditionLine = `Condition: "${ctx.step.successCondition}"\nResult: ${ctx.conditionCheck.complete ? "PASS" : "FAIL"} — ${ctx.conditionCheck.reason}`

    return renderTemplate(templates.evaluate, {
      goal: ctx.step.goal,
      successCondition: ctx.step.successCondition,
      subagentReport: ctx.subagentReport.slice(-2000),
      stateDiff: ctx.stateDiff,
      stateSnapshot: JSON.stringify(stateSnapshot),
      conditionLine,
      timingLine,
      overrunWarning,
    })
  },

  subagentPrompt(ctx) {
    const briefing = buildStateSummary(ctx.state as GameState, ctx.situation as Situation)
    const budgetSeconds = Math.round(ctx.step.timeoutTicks * ctx.identity.tickIntervalSec)

    return renderTemplate(templates.subagent, {
      task: ctx.step.task,
      goal: ctx.step.goal,
      successCondition: ctx.step.successCondition,
      timeoutTicks: String(ctx.step.timeoutTicks),
      budgetSeconds: String(budgetSeconds),
      briefing,
      personality: ctx.identity.personality.slice(0, 800),
      values: ctx.identity.values.slice(0, 500),
      toolDocs: TOOL_DOCS,
    })
  },
})

// ── Layer ────────────────────────────────────────────────────

const TEMPLATE_NAMES = ["plan", "interrupt", "evaluate", "subagent"] as const

/** Layer providing the SpaceMolt prompt builder. Templates are loaded eagerly at construction. */
export const SpaceMoltPromptBuilderLive = Layer.effect(
  PromptBuilderTag,
  Effect.gen(function* () {
    const templates: Record<string, string> = {}
    for (const name of TEMPLATE_NAMES) {
      templates[name] = yield* loadTemplate(path.join(PROMPTS_DIR, `${name}.md`))
    }
    return makePromptBuilder(templates)
  }),
)
