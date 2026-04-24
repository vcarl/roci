/**
 * OodaRunner — loads OODA skill templates and invokes them via `runTurn(noTools: true)`.
 *
 * Each function renders a skill template with domain-specific variables, sends it to
 * an LLM via `runTurn`, and parses the JSON response. Observe/orient use the fast/smart
 * tiers; decide/evaluate use reasoning.
 */

import * as path from "node:path"
import { Effect } from "effect"
import { loadSkillSync } from "../skills/loader.js"
import { getCadenceGuidance, type Cadence } from "../skills/cadence.js"
import type {
  ObserveResult,
  OrientResult,
  DecideResult,
  EvaluateResult,
  WaitState,
} from "../skills/types.js"
import { runTurn } from "./limbic/hypothalamus/process-runner.js"
import type { ModelConfig } from "./model-config.js"
import { resolveModel } from "./model-config.js"
import type { CharacterConfig } from "../services/CharacterFs.js"
import type { CommandExecutor } from "@effect/platform"
import type { CharacterLog } from "../logging/log-writer.js"
import { logToConsole } from "../logging/log-writer.js"
import type { LogWriterError } from "../logging/log-writer.js"
import type { OAuthToken } from "../services/OAuthToken.js"

// ── Skill template loading (cached at module level) ─────────

const SKILLS_DIR = path.resolve(import.meta.dirname, "../skills")

const skills = {
  observe: loadSkillSync(path.join(SKILLS_DIR, "observe.md")),
  orient: loadSkillSync(path.join(SKILLS_DIR, "orient.md")),
  decide: loadSkillSync(path.join(SKILLS_DIR, "decide.md")),
  evaluate: loadSkillSync(path.join(SKILLS_DIR, "evaluate.md")),
}

// ── JSON extraction ─────────────────────────────────────────

/**
 * Extract JSON from LLM output that may be wrapped in markdown code fences.
 */
export function extractJson(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  return match ? match[1].trim() : text.trim()
}

// ── Config types ────────────────────────────────────────────

export interface OodaRunnerConfig {
  containerId: string
  playerName: string
  char: CharacterConfig
  cadence: Cadence
  models: ModelConfig
  addDirs?: string[]
  env?: Record<string, string>
}

export interface OodaState {
  accumulatedEvents: string[]
  emotionalWeight: string
  currentPlan: DecideResult | null
  currentStepIndex: number
  stepStartTick: number
  waitState: WaitState | null
  lastOrientTick: number
}

// ── Shared dependencies ─────────────────────────────────────

type OodaDeps = CommandExecutor.CommandExecutor | CharacterLog | OAuthToken

// ── Timeout constants (ms) ──────────────────────────────────

const OBSERVE_TIMEOUT_MS = 30_000
const ORIENT_TIMEOUT_MS = 60_000
const DECIDE_TIMEOUT_MS = 90_000
const EVALUATE_TIMEOUT_MS = 90_000

// ── Observe ─────────────────────────────────────────────────

export function runObserve(
  config: OodaRunnerConfig,
  events: string[],
  waitState: WaitState | null,
): Effect.Effect<ObserveResult, LogWriterError, OodaDeps> {
  return Effect.gen(function* () {
    const eventsFormatted = events
      .map((e, i) => `[Event ${i + 1}] ${e}`)
      .join("\n\n")

    const waitStateStr = waitState
      ? `Waiting for: ${waitState.waitingFor}\nResolution signal: ${waitState.resolutionSignal}\nDisposition: ${waitState.disposition}`
      : "None — not currently waiting."

    const prompt = skills.observe.render({
      cadence: config.cadence,
      cadenceGuidance: getCadenceGuidance("observe", config.cadence),
      events: eventsFormatted,
      waitState: waitStateStr,
    })

    const model = resolveModel(config.models, "oodaObserve", "fast")

    const result = yield* runTurn({
      containerId: config.containerId,
      playerName: config.playerName,
      char: config.char,
      prompt,
      systemPrompt: "",
      model,
      timeoutMs: OBSERVE_TIMEOUT_MS,
      role: "brain",
      noTools: true,
      addDirs: config.addDirs,
      env: config.env,
    }).pipe(
      Effect.catchAll((e) =>
        Effect.gen(function* () {
          yield* logToConsole(config.char.name, "ooda", `observe failed: ${e}`)
          return { output: "", timedOut: true, durationMs: 0 }
        }),
      ),
    )

    try {
      const json = extractJson(result.output)
      return JSON.parse(json) as ObserveResult
    } catch {
      yield* logToConsole(config.char.name, "ooda", `observe parse failed, defaulting to discard. Raw: ${result.output.slice(0, 200)}`)
      return { disposition: "discard" as const, emotionalWeight: "😐", reason: "Parse failure — defaulting to discard" }
    }
  })
}

// ── Orient ──────────────────────────────────────────────────

export function runOrient(
  config: OodaRunnerConfig,
  accumulatedEvents: string[],
  domainState: string,
  identity: { background: string; values: string; diary: string },
  emotionalWeight: string,
): Effect.Effect<OrientResult, LogWriterError, OodaDeps> {
  return Effect.gen(function* () {
    const prompt = skills.orient.render({
      cadence: config.cadence,
      cadenceGuidance: getCadenceGuidance("orient", config.cadence),
      accumulatedEvents: accumulatedEvents.join("\n\n"),
      domainState,
      background: identity.background,
      values: identity.values,
      diary: identity.diary,
      emotionalWeight,
    })

    const model = resolveModel(config.models, "oodaOrient", "smart")

    const result = yield* runTurn({
      containerId: config.containerId,
      playerName: config.playerName,
      char: config.char,
      prompt,
      systemPrompt: "",
      model,
      timeoutMs: ORIENT_TIMEOUT_MS,
      role: "brain",
      noTools: true,
      addDirs: config.addDirs,
      env: config.env,
    }).pipe(
      Effect.catchAll((e) =>
        Effect.gen(function* () {
          yield* logToConsole(config.char.name, "ooda", `orient failed: ${e}`)
          return { output: "", timedOut: true, durationMs: 0 }
        }),
      ),
    )

    try {
      const json = extractJson(result.output)
      return JSON.parse(json) as OrientResult
    } catch {
      yield* logToConsole(config.char.name, "ooda", `orient parse failed. Raw: ${result.output.slice(0, 200)}`)
      return {
        headline: "Orient parse failure — situation unknown",
        sections: [],
        whatChanged: "Unknown — orient could not parse",
        emotionalState: emotionalWeight,
        metrics: {},
      }
    }
  })
}

// ── Decide ──────────────────────────────────────────────────

export function runDecide(
  config: OodaRunnerConfig,
  orientResult: OrientResult,
  currentPlanState: string,
  availableSkills: string,
): Effect.Effect<DecideResult, LogWriterError, OodaDeps> {
  return Effect.gen(function* () {
    const sectionsFormatted = orientResult.sections
      .map((s) => `#### ${s.heading}\n${s.body}`)
      .join("\n\n")

    const prompt = skills.decide.render({
      cadence: config.cadence,
      cadenceGuidance: getCadenceGuidance("decide", config.cadence),
      headline: orientResult.headline,
      whatChanged: orientResult.whatChanged,
      emotionalState: orientResult.emotionalState,
      sections: sectionsFormatted,
      metrics: JSON.stringify(orientResult.metrics, null, 2),
      currentPlanState,
      availableSkills,
    })

    const model = resolveModel(config.models, "oodaDecide", "reasoning")

    const result = yield* runTurn({
      containerId: config.containerId,
      playerName: config.playerName,
      char: config.char,
      prompt,
      systemPrompt: "",
      model,
      timeoutMs: DECIDE_TIMEOUT_MS,
      role: "brain",
      noTools: true,
      addDirs: config.addDirs,
      env: config.env,
    }).pipe(
      Effect.catchAll((e) =>
        Effect.gen(function* () {
          yield* logToConsole(config.char.name, "ooda", `decide failed: ${e}`)
          return { output: "", timedOut: true, durationMs: 0 }
        }),
      ),
    )

    try {
      const json = extractJson(result.output)
      return JSON.parse(json) as DecideResult
    } catch {
      yield* logToConsole(config.char.name, "ooda", `decide parse failed, defaulting to continue. Raw: ${result.output.slice(0, 200)}`)
      return { decision: "continue" as const, reasoning: "Parse failure — defaulting to continue" }
    }
  })
}

// ── Evaluate ────────────────────────────────────────────────

export interface EvaluateInput {
  task: string
  goal: string
  successCondition: string
  ticksBudgeted: number
  ticksConsumed: number
  executionReport: string
  stateDiff: string
  conditionCheck: string
  emotionalState: string
  remainingSteps: string
}

export function runEvaluate(
  config: OodaRunnerConfig,
  input: EvaluateInput,
): Effect.Effect<EvaluateResult, LogWriterError, OodaDeps> {
  return Effect.gen(function* () {
    const secondsBudgeted = input.ticksBudgeted * 30
    const secondsConsumed = input.ticksConsumed * 30
    const overrunWarning =
      input.ticksConsumed > input.ticksBudgeted
        ? `\n\n**OVERRUN:** consumed ${input.ticksConsumed} ticks against a ${input.ticksBudgeted}-tick budget (${secondsConsumed}s vs ${secondsBudgeted}s planned)`
        : ""

    const prompt = skills.evaluate.render({
      cadence: config.cadence,
      cadenceGuidance: getCadenceGuidance("evaluate", config.cadence),
      task: input.task,
      goal: input.goal,
      successCondition: input.successCondition,
      ticksBudgeted: String(input.ticksBudgeted),
      secondsBudgeted: String(secondsBudgeted),
      ticksConsumed: String(input.ticksConsumed),
      secondsConsumed: String(secondsConsumed),
      overrunWarning,
      executionReport: input.executionReport,
      stateDiff: input.stateDiff,
      conditionCheck: input.conditionCheck,
      emotionalState: input.emotionalState,
      remainingSteps: input.remainingSteps,
    })

    const model = resolveModel(config.models, "oodaEvaluate", "reasoning")

    const result = yield* runTurn({
      containerId: config.containerId,
      playerName: config.playerName,
      char: config.char,
      prompt,
      systemPrompt: "",
      model,
      timeoutMs: EVALUATE_TIMEOUT_MS,
      role: "brain",
      noTools: true,
      addDirs: config.addDirs,
      env: config.env,
    }).pipe(
      Effect.catchAll((e) =>
        Effect.gen(function* () {
          yield* logToConsole(config.char.name, "ooda", `evaluate failed: ${e}`)
          return { output: "", timedOut: true, durationMs: 0 }
        }),
      ),
    )

    try {
      const json = extractJson(result.output)
      return JSON.parse(json) as EvaluateResult
    } catch {
      yield* logToConsole(config.char.name, "ooda", `evaluate parse failed. Raw: ${result.output.slice(0, 200)}`)
      return {
        judgment: "partially_succeeded" as const,
        reasoning: "Parse failure — cannot determine outcome",
        transition: { transition: "next_step" as const },
      }
    }
  })
}

// ── Utility: format tool events into execution report ───────

export function formatExecutionReport(events: Array<{ kind: string; tool?: string; input?: unknown; output?: unknown }>): string {
  if (events.length === 0) return "No tool activity observed."
  return events
    .map((e) => {
      if (e.kind === "tool_use") {
        const inputStr = typeof e.input === "string" ? e.input : JSON.stringify(e.input ?? "")
        return `${e.tool ?? "unknown"}: ${inputStr.slice(0, 200)}`
      }
      if (e.kind === "tool_result") {
        const outputStr = typeof e.output === "string" ? e.output : JSON.stringify(e.output ?? "")
        return `  → ${outputStr.slice(0, 150)}`
      }
      return ""
    })
    .filter(Boolean)
    .join("\n")
}
