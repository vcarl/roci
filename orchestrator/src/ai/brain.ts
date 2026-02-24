import { Effect } from "effect"
import { Claude, ClaudeError } from "../services/Claude.js"
import type { AiFunction } from "./AiFunction.js"
import type { Plan } from "./types.js"
import type { GameState, Situation, Alert } from "../../../harness/src/types.js"

export interface BrainPlanInput {
  state: GameState
  situation: Situation
  diary: string
  briefing: string
  background: string
  values: string
}

export interface BrainInterruptInput {
  state: GameState
  situation: Situation
  alerts: Alert[]
  currentPlan: Plan | null
  briefing: string
  background: string
}

const PLAN_SYSTEM_PROMPT = `You are a strategic planning AI for a character in the SpaceMolt MMO.
You analyze the current game state and produce a structured plan.
Your output must be ONLY valid JSON matching this schema:
{
  "reasoning": "string — your strategic thinking",
  "steps": [
    {
      "task": "mine|travel|sell|dock|refuel|repair|chat|explore|combat|undock",
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
- Set realistic timeoutTicks (1 tick ≈ 30 seconds typically)
- Consider the character's personality and values when planning`

const INTERRUPT_SYSTEM_PROMPT = `You are a strategic planning AI reacting to an urgent situation in SpaceMolt MMO.
A critical alert has been detected and the current plan needs to be revised.
Your output must be ONLY valid JSON matching the same Plan schema.
Prioritize survival and safety. Act decisively.`

function parsePlan(output: string): Plan {
  // Try to extract JSON from the output (may have markdown fences)
  let json = output.trim()
  const fenceMatch = json.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (fenceMatch) {
    json = fenceMatch[1]
  }
  const parsed = JSON.parse(json)
  return {
    reasoning: parsed.reasoning ?? "",
    steps: Array.isArray(parsed.steps)
      ? parsed.steps.map((s: Record<string, unknown>) => ({
          task: (s.task as string) ?? "explore",
          goal: (s.goal as string) ?? "",
          model: (s.model as "haiku" | "sonnet") ?? "haiku",
          successCondition: (s.successCondition as string) ?? "",
          timeoutTicks: (s.timeoutTicks as number) ?? 10,
        }))
      : [],
  }
}

export const brainPlan: AiFunction<BrainPlanInput, Plan, Claude, ClaudeError> = {
  name: "brain.plan",
  execute: (input) =>
    Effect.gen(function* () {
      const claude = yield* Claude

      const prompt = `# Current Game State

## Briefing
${input.briefing}

## Alerts
${input.situation.alerts.map((a) => `[${a.priority}] ${a.message}`).join("\n") || "None"}

## Character Background
${input.background}

## Character Values
${input.values}

## Diary (recent memory)
${input.diary.slice(-2000)}

---

Based on the current state, create a strategic plan. Consider:
1. What situation is the character in? (${input.situation.type})
2. Are there any alerts to address?
3. What would this character prioritize?
4. What sequence of actions makes sense?

Output ONLY the JSON plan.`

      const output = yield* claude.invoke({
        prompt,
        model: "opus",
        systemPrompt: PLAN_SYSTEM_PROMPT,
        outputFormat: "text",
        maxTurns: 1,
      })

      try {
        return parsePlan(output)
      } catch (e) {
        return yield* Effect.fail(
          new ClaudeError(`Failed to parse brain plan output: ${e}`, output),
        )
      }
    }),
}

export const brainInterrupt: AiFunction<BrainInterruptInput, Plan, Claude, ClaudeError> = {
  name: "brain.interrupt",
  execute: (input) =>
    Effect.gen(function* () {
      const claude = yield* Claude

      const currentPlanSummary = input.currentPlan
        ? `Current plan:\n${input.currentPlan.steps.map((s, i) => `${i + 1}. [${s.task}] ${s.goal}`).join("\n")}`
        : "No active plan."

      const prompt = `# URGENT INTERRUPT

## Critical Alerts
${input.alerts.map((a) => `[${a.priority}] ${a.message} (suggested: ${a.suggestedAction ?? "none"})`).join("\n")}

## Current State
${input.briefing}

## ${currentPlanSummary}

## Character Background (brief)
${input.background.slice(0, 1000)}

---

React to this situation. Create a revised plan that addresses the immediate danger first, then considers what to do after.
Output ONLY the JSON plan.`

      const output = yield* claude.invoke({
        prompt,
        model: "opus",
        systemPrompt: INTERRUPT_SYSTEM_PROMPT,
        outputFormat: "text",
        maxTurns: 1,
      })

      try {
        return parsePlan(output)
      } catch (e) {
        return yield* Effect.fail(
          new ClaudeError(`Failed to parse brain interrupt output: ${e}`, output),
        )
      }
    }),
}
