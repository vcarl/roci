import { Layer } from "effect"
import type {
  PromptBuilder,
  PlanPromptContext,
  InterruptPromptContext,
  EvaluatePromptContext,
} from "../../core/prompt-builder.js"
import { PromptBuilderTag } from "../../core/prompt-builder.js"
import type { PlanStep } from "../../core/types.js"
import type { GameState, Situation } from "../../../../harness/src/types.js"
import { snapshot } from "./state-renderer.js"

// ── Planning prompts ────────────────────────────────────────

const TASK_LIST = "mine|travel|sell|dock|undock|refuel|repair|combat|chat|explore"

function buildPlanSystemPrompt(tickIntervalSec: number): string {
  return `You are a strategic planning AI for a character in the SpaceMolt MMO.
You analyze the current game state and produce a structured plan.
Your output must be ONLY valid JSON matching this schema:
{
  "reasoning": "string — your strategic thinking",
  "steps": [
    {
      "task": "${TASK_LIST}",
      "goal": "string — natural language goal for the agent executing this step",
      "model": "haiku|sonnet",
      "successCondition": "string — how to verify this step is done, checked against game state",
      "timeoutTicks": number
    }
  ]
}

Guidelines:
- Use "haiku" for routine tasks (mining, traveling, selling, docking, refueling)
- Use "sonnet" for tasks requiring judgment (combat, social interaction, complex trading)
- Keep plans 2-6 steps long. Don't over-plan.
- Success conditions should be observable from game state (e.g., "cargo_used > 90% of capacity", "docked_at_base is not null", "current_system == X")
- 1 tick ≈ ${tickIntervalSec}s (from server tick_rate). Set realistic timeoutTicks based on task complexity and recent step performance.
- Agents that exceed their tick budget are penalized in evaluation. Set realistic timeoutTicks.
- Consider the character's personality and values when planning`
}

function buildPlanUserPrompt(ctx: PlanPromptContext<GameState, Situation>): string {
  const failureSection = ctx.previousFailure
    ? `\n## Previous Plan Failed\n${ctx.previousFailure}\n\nYour previous plan hit a problem. Account for this when making a new plan — you may need to retry the failed step, try a different approach, or adjust the overall strategy.\n`
    : ""

  const chatSection = ctx.recentChat && ctx.recentChat.length > 0
    ? `\n## Recent Chat\n${ctx.recentChat.map((m) => `[${m.channel}] ${m.sender}: ${m.content}`).join("\n")}\n\nConsider whether any of these messages warrant a response or affect your plans.\n`
    : ""

  const timingSection = ctx.stepTimingHistory && ctx.stepTimingHistory.length > 0
    ? `\n## Recent Step Outcomes\n${ctx.stepTimingHistory.map((h) => {
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
    : ""

  const additionalSection = ctx.additionalContext
    ? `\n## Additional Context\n${ctx.additionalContext}\n`
    : ""

  return `# Current Game State

## Briefing
${ctx.briefing}
${failureSection}${chatSection}${timingSection}${additionalSection}
## Character Background
${ctx.background}

## Character Values
${ctx.values}

## Diary (recent memory)
${ctx.diary.slice(-2000)}

---

Based on the current state, create a strategic plan. Consider:
1. What situation is the character in? (${ctx.situation.type})
2. What would this character prioritize?
3. What sequence of actions makes sense?

Output ONLY the JSON plan.`
}

// ── Interrupt prompts ───────────────────────────────────────

const INTERRUPT_SYSTEM_PROMPT = `You are a strategic planning AI reacting to an urgent situation in SpaceMolt MMO.
A critical alert has been detected and the current plan needs to be revised.
Your output must be ONLY valid JSON matching the same Plan schema.
Prioritize survival and safety. Act decisively.`

function buildInterruptUserPrompt(ctx: InterruptPromptContext<GameState, Situation>): string {
  const currentPlanSummary = ctx.currentPlan
    ? `Current plan:\n${ctx.currentPlan.steps.map((s: { task: string; goal: string }, i: number) => `${i + 1}. [${s.task}] ${s.goal}`).join("\n")}`
    : "No active plan."

  return `# URGENT INTERRUPT

## Critical Alerts
${ctx.alerts.map((a) => `[${a.priority}] ${a.message} (suggested: ${a.suggestedAction ?? "none"})`).join("\n")}

## Current State
${ctx.briefing}

## ${currentPlanSummary}

## Character Background (brief)
${ctx.background.slice(0, 1000)}

---

React to this situation. Create a revised plan that addresses the immediate danger first, then considers what to do after.
Output ONLY the JSON plan.`
}

// ── Evaluation prompts ──────────────────────────────────────

const EVALUATE_SYSTEM_PROMPT = "You are the strategic brain evaluating whether your sub-agent accomplished the task you assigned. Be pragmatic — if reasonable progress was made toward the goal, consider it complete. Only mark incomplete if the agent clearly failed, gave up, or did something unrelated. The state diff and deterministic condition check give you objective evidence of what changed — use them. Keep your reason under 50 words."

function buildEvaluateUserPrompt(ctx: EvaluatePromptContext<GameState, Situation>): string {
  const stateSnapshot = snapshot(ctx.state as GameState)

  const secondsConsumed = Math.round(ctx.ticksConsumed * ctx.tickIntervalSec)
  const secondsBudgeted = Math.round(ctx.ticksBudgeted * ctx.tickIntervalSec)
  const overrunDelta = ctx.ticksConsumed - ctx.ticksBudgeted
  const timingLine = `Timing: consumed ${ctx.ticksConsumed} of ${ctx.ticksBudgeted} budgeted ticks (~${secondsConsumed}s of ~${secondsBudgeted}s).`
  const overrunWarning = overrunDelta > 0
    ? `\nWARNING: exceeded tick budget by ${overrunDelta} ticks. Factor this into your evaluation.`
    : ""

  const conditionLine = `Condition: "${ctx.step.successCondition}"\nResult: ${ctx.conditionCheck.complete ? "PASS" : "FAIL"} — ${ctx.conditionCheck.reason}`

  return `You assigned this task to a sub-agent:
Goal: "${ctx.step.goal}"
Success condition: "${ctx.step.successCondition}"

The sub-agent reported:
${ctx.subagentReport.slice(-2000)}

## State Changes (before -> after)
${ctx.stateDiff}

Current game state after the sub-agent finished:
${JSON.stringify(stateSnapshot)}

## Deterministic Condition Check
${conditionLine}

${timingLine}${overrunWarning}

Evaluate: did the sub-agent accomplish the goal? Respond with ONLY JSON:
{"complete": true/false, "reason": "brief explanation of what happened and why you consider this complete or not"}`
}

// ── Subagent prompts ────────────────────────────────────────

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

const TOOL_DOCS = `The \`sm\` CLI is installed on your PATH. Run \`sm --help\` for all commands, or \`sm commands\` for a categorized reference.`

function buildSubagentPromptText(
  step: PlanStep,
  state: GameState,
  situation: Situation,
  identity: { personality: string; values: string; tickIntervalSec: number },
): string {
  const briefing = buildStateSummary(state, situation)
  const budgetSeconds = Math.round(step.timeoutTicks * identity.tickIntervalSec)

  return `# Your Mission

You are executing a "${step.task}" task. Use the \`sm\` CLI to interact with the game.

## Specific Goal
${step.goal}

## Success Condition
${step.successCondition}

## Time Budget
You have ${step.timeoutTicks} game ticks (~${budgetSeconds}s) to complete this task.
Work efficiently — execute commands, check results, and move on. Do not deliberate excessively.
If you are running low on time, wrap up with a COMPLETION REPORT of what you accomplished.

## Current State
${briefing}

## Who You Are
${identity.personality.slice(0, 800)}

## Your Values (brief)
${identity.values.slice(0, 500)}

## Available Commands
${TOOL_DOCS}

Stay focused on your specific goal. When you've achieved it or cannot make further progress, stop.

When you are finished (goal achieved or no further progress possible), write a brief
COMPLETION REPORT as your final message summarizing:
- What you accomplished
- What commands you ran and their outcomes
- Whether you believe the goal was met
- Any issues or blockers encountered`
}

// ── Prompt builder ──────────────────────────────────────────

const spaceMoltPromptBuilder: PromptBuilder<GameState, Situation> = {
  planPrompt(ctx) {
    return {
      system: buildPlanSystemPrompt(ctx.tickIntervalSec),
      user: buildPlanUserPrompt(ctx),
    }
  },

  interruptPrompt(ctx) {
    return {
      system: INTERRUPT_SYSTEM_PROMPT,
      user: buildInterruptUserPrompt(ctx),
    }
  },

  evaluatePrompt(ctx) {
    return {
      system: EVALUATE_SYSTEM_PROMPT,
      user: buildEvaluateUserPrompt(ctx),
    }
  },

  subagentPrompt(ctx) {
    return buildSubagentPromptText(
      ctx.step,
      ctx.state as GameState,
      ctx.situation as Situation,
      ctx.identity,
    )
  },
}

// ── Layer ────────────────────────────────────────────────────

/** Layer providing the SpaceMolt prompt builder. */
export const SpaceMoltPromptBuilderLive = Layer.succeed(PromptBuilderTag, spaceMoltPromptBuilder)

