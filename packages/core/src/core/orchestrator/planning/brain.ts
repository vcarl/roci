import { Effect } from "effect"
import { CommandExecutor } from "@effect/platform"
import { ClaudeError, type AnyModel } from "../../../services/Claude.js"
import { OAuthToken } from "../../../services/OAuthToken.js"
import { CharacterLog } from "../../../logging/log-writer.js"
import type { AiFunction } from "../../AiFunction.js"
import { PromptBuilderTag } from "../../prompt-builder.js"
import type { PlanPromptContext, InterruptPromptContext, EvaluatePromptContext } from "../../prompt-builder.js"
import { StateRendererTag } from "../../state-renderer.js"
import type { Plan, StepCompletionResult } from "../../types.js"
import { runTurn } from "../../limbic/hypothalamus/process-runner.js"
import type { CharacterConfig } from "../../../services/CharacterFs.js"

/** Container context needed by brain functions to run in-container via runTurn. */
export interface BrainContainerContext {
  containerId: string
  playerName: string
  char: CharacterConfig
  containerEnv?: Record<string, string>
  addDirs?: string[]
  /** Override model for this brain turn. Anthropic aliases use Docker; any other string routes to OpenRouter. */
  model?: AnyModel
}

// ── JSON Schemas for structured output ──────────────────────

const PLAN_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    reasoning: { type: "string" },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          task: { type: "string" },
          goal: { type: "string" },
          model: { type: "string", enum: ["haiku", "sonnet"] },
          successCondition: { type: "string" },
          timeoutTicks: { type: "number" },
        },
        required: ["task", "goal"],
      },
    },
    procedure: { type: "string" },
    targets: { type: "array", items: { type: "string" } },
  },
  required: ["reasoning", "steps"],
})

const EVAL_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    complete: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["complete", "reason"],
})

// ── Plan parsing ────────────────────────────────────────────

function parsePlan(output: string, validProcedures?: string[]): Plan {
  let json = output.trim()
  // Fallback: strip markdown fences if present (legacy or non-schema path)
  const fenceMatch = json.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (fenceMatch) {
    json = fenceMatch[1]
  }
  const parsed = JSON.parse(json)
  const plan: Plan = {
    reasoning: parsed.reasoning ?? "",
    steps: Array.isArray(parsed.steps)
      ? parsed.steps.map((s: Record<string, unknown>) => ({
          task: (s.task as string) ?? "explore",
          goal: (s.goal as string) ?? "",
          model: (s.model as "haiku" | "sonnet") ?? "haiku",
          successCondition: (s.successCondition as string) ?? "",
          timeoutTicks: (s.timeoutTicks as number) ?? 30,
        }))
      : [],
  }

  // Extract procedure selection if present
  const procs = validProcedures ?? ["triage", "feature", "review"]
  if (parsed.procedure && procs.includes(parsed.procedure)) {
    plan.procedure = parsed.procedure
    plan.targets = Array.isArray(parsed.targets) ? parsed.targets : []
  }

  return plan
}

// ── Brain functions ─────────────────────────────────────────

export const brainPlan: AiFunction<PlanPromptContext & BrainContainerContext, Plan, PromptBuilderTag | CommandExecutor.CommandExecutor | CharacterLog | OAuthToken, ClaudeError> = {
  name: "brain.plan",
  execute: (input) =>
    Effect.gen(function* () {
      const promptBuilder = yield* PromptBuilderTag

      const prompt = promptBuilder.planPrompt(input)

      const result = yield* runTurn({
        containerId: input.containerId,
        playerName: input.playerName,
        char: input.char,
        systemPrompt: "",
        prompt,
        model: input.model ?? "sonnet",
        timeoutMs: 90_000,
        env: input.containerEnv,
        addDirs: input.addDirs,
        role: "brain",
        jsonSchema: PLAN_SCHEMA,
      })

      if (result.timedOut || !result.output.trim()) {
        return yield* Effect.fail(
          new ClaudeError("Brain plan timed out or returned empty output"),
        )
      }

      try {
        return parsePlan(result.output)
      } catch (e) {
        return yield* Effect.fail(
          new ClaudeError(`Failed to parse brain plan output: ${e}`, result.output),
        )
      }
    }),
}

export const brainInterrupt: AiFunction<InterruptPromptContext & BrainContainerContext, Plan, PromptBuilderTag | CommandExecutor.CommandExecutor | CharacterLog | OAuthToken, ClaudeError> = {
  name: "brain.interrupt",
  execute: (input) =>
    Effect.gen(function* () {
      const promptBuilder = yield* PromptBuilderTag

      const prompt = promptBuilder.interruptPrompt(input)

      const result = yield* runTurn({
        containerId: input.containerId,
        playerName: input.playerName,
        char: input.char,
        systemPrompt: "",
        prompt,
        model: input.model ?? "sonnet",
        timeoutMs: 90_000,
        env: input.containerEnv,
        addDirs: input.addDirs,
        role: "brain",
        jsonSchema: PLAN_SCHEMA,
      })

      if (result.timedOut || !result.output.trim()) {
        return yield* Effect.fail(
          new ClaudeError("Brain interrupt timed out or returned empty output"),
        )
      }

      try {
        return parsePlan(result.output)
      } catch (e) {
        return yield* Effect.fail(
          new ClaudeError(`Failed to parse brain interrupt output: ${e}`, result.output),
        )
      }
    }),
}

export const brainEvaluate: AiFunction<EvaluatePromptContext & BrainContainerContext, StepCompletionResult, PromptBuilderTag | StateRendererTag | CommandExecutor.CommandExecutor | CharacterLog | OAuthToken, ClaudeError> = {
  name: "brain.evaluate",
  execute: (input) =>
    Effect.gen(function* () {
      const promptBuilder = yield* PromptBuilderTag
      const renderer = yield* StateRendererTag

      const prompt = promptBuilder.evaluatePrompt(input)

      const result = yield* runTurn({
        containerId: input.containerId,
        playerName: input.playerName,
        char: input.char,
        systemPrompt: "",
        prompt,
        model: input.model ?? "haiku",
        timeoutMs: 60_000,
        env: input.containerEnv,
        addDirs: input.addDirs,
        role: "brain",
        jsonSchema: EVAL_SCHEMA,
      })

      if (result.timedOut || !result.output.trim()) {
        return yield* Effect.fail(
          new ClaudeError("Brain evaluate timed out or returned empty output"),
        )
      }

      let json = result.output.trim()
      const fenceMatch = json.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
      if (fenceMatch) {
        json = fenceMatch[1]
      }

      try {
        const parsed = JSON.parse(json)
        const stateSnapshot = renderer.snapshot(input.state)

        return {
          complete: parsed.complete as boolean,
          reason: parsed.reason as string,
          matchedCondition: null,
          relevantState: stateSnapshot,
        } satisfies StepCompletionResult
      } catch (e) {
        return yield* Effect.fail(
          new ClaudeError(`Failed to parse brain evaluate output: ${e}`, result.output),
        )
      }
    }),
}
