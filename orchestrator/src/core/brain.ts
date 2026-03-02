import { Effect } from "effect"
import { Claude, ClaudeError } from "../services/Claude.js"
import type { AiFunction } from "./AiFunction.js"
import { PromptBuilderTag } from "./prompt-builder.js"
import type { PlanPromptContext, InterruptPromptContext, EvaluatePromptContext } from "./prompt-builder.js"
import { StateRendererTag } from "./state-renderer.js"
import type { Plan, StepCompletionResult } from "./types.js"

// ── Plan parsing ────────────────────────────────────────────

function parsePlan(output: string): Plan {
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

// ── Brain functions ─────────────────────────────────────────

export const brainPlan: AiFunction<PlanPromptContext, Plan, Claude | PromptBuilderTag, ClaudeError> = {
  name: "brain.plan",
  execute: (input) =>
    Effect.gen(function* () {
      const claude = yield* Claude
      const promptBuilder = yield* PromptBuilderTag

      const prompt = promptBuilder.planPrompt(input)

      const output = yield* claude.invoke({
        prompt,
        model: "opus",
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

export const brainInterrupt: AiFunction<InterruptPromptContext, Plan, Claude | PromptBuilderTag, ClaudeError> = {
  name: "brain.interrupt",
  execute: (input) =>
    Effect.gen(function* () {
      const claude = yield* Claude
      const promptBuilder = yield* PromptBuilderTag

      const prompt = promptBuilder.interruptPrompt(input)

      const output = yield* claude.invoke({
        prompt,
        model: "opus",
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

export const brainEvaluate: AiFunction<EvaluatePromptContext, StepCompletionResult, Claude | PromptBuilderTag | StateRendererTag, ClaudeError> = {
  name: "brain.evaluate",
  execute: (input) =>
    Effect.gen(function* () {
      const claude = yield* Claude
      const promptBuilder = yield* PromptBuilderTag
      const renderer = yield* StateRendererTag

      const prompt = promptBuilder.evaluatePrompt(input)

      const output = yield* claude.invoke({
        prompt,
        model: "opus",
        outputFormat: "text",
        maxTurns: 1,
      })

      let json = output.trim()
      const fenceMatch = json.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
      if (fenceMatch) {
        json = fenceMatch[1]
      }
      const parsed = JSON.parse(json)
      const stateSnapshot = renderer.snapshot(input.state)

      return {
        complete: parsed.complete as boolean,
        reason: parsed.reason as string,
        matchedCondition: null,
        relevantState: stateSnapshot,
      } satisfies StepCompletionResult
    }),
}
