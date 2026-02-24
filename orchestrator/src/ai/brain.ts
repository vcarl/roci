import { Effect } from "effect"
import { Claude, ClaudeError } from "../services/Claude.js"
import type { AiFunction } from "./AiFunction.js"
import type { Plan, PlanStep } from "./types.js"
import type { GameState, Situation, Alert } from "../../../harness/src/types.js"
import { type StepCompletionResult, buildStateSnapshot } from "../monitor/plan-tracker.js"

export interface BrainPlanInput {
  state: GameState
  situation: Situation
  diary: string
  briefing: string
  background: string
  values: string
  previousFailure?: string  // what went wrong with the last plan, if replanning after failure
}

export interface BrainInterruptInput {
  state: GameState
  situation: Situation
  alerts: Alert[]
  currentPlan: Plan | null
  briefing: string
  background: string
}

export interface BrainEvaluateInput {
  step: PlanStep
  subagentReport: string
  state: GameState
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

      const failureSection = input.previousFailure
        ? `\n## Previous Plan Failed\n${input.previousFailure}\n\nYour previous plan hit a problem. Account for this when making a new plan — you may need to retry the failed step, try a different approach, or adjust the overall strategy.\n`
        : ""

      const prompt = `# Current Game State

## Briefing
${input.briefing}

## Alerts
${input.situation.alerts.map((a) => `[${a.priority}] ${a.message}`).join("\n") || "None"}
${failureSection}
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

export const brainEvaluate: AiFunction<BrainEvaluateInput, StepCompletionResult, Claude, ClaudeError> = {
  name: "brain.evaluate",
  execute: (input) =>
    Effect.gen(function* () {
      const claude = yield* Claude
      const stateSnapshot = buildStateSnapshot(input.state)

      const output = yield* claude.invoke({
        prompt: `You assigned this task to a sub-agent:
Goal: "${input.step.goal}"
Success condition: "${input.step.successCondition}"

The sub-agent reported:
${input.subagentReport.slice(-2000)}

Current game state after the sub-agent finished:
${JSON.stringify(stateSnapshot)}

Evaluate: did the sub-agent accomplish the goal? Respond with ONLY JSON:
{"complete": true/false, "reason": "brief explanation of what happened and why you consider this complete or not"}`,
        model: "opus",
        systemPrompt: "You are the strategic brain evaluating whether your sub-agent accomplished the task you assigned. Be pragmatic — if reasonable progress was made toward the goal, consider it complete. Only mark incomplete if the agent clearly failed, gave up, or did something unrelated. Keep your reason under 50 words.",
        outputFormat: "text",
        maxTurns: 1,
      })

      // Try to extract JSON from possible markdown fences
      let json = output.trim()
      const fenceMatch = json.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
      if (fenceMatch) {
        json = fenceMatch[1]
      }
      const parsed = JSON.parse(json)

      return {
        complete: parsed.complete as boolean,
        reason: parsed.reason as string,
        matchedCondition: null,
        relevantState: stateSnapshot,
      } satisfies StepCompletionResult
    }),
}
