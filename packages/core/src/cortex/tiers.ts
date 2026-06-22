import * as path from "node:path"
import { Effect } from "effect"
import { ModelClient } from "../model/client.js"
import type { ModelError } from "../model/errors.js"
import { resolveHandle, type CortexModelConfig } from "../model/handles.js"
import { loadSkillSync } from "../skills/loader.js"
import { getCadenceGuidance, type Cadence } from "../skills/cadence.js"
import { TEMPLATE_PALETTE } from "../core/palette.js"
import type {
  ObserveResult,
  OrientResult,
  DecideResult,
  EvaluateResult,
  WaitState,
} from "../skills/types.js"
import type { CharacterConfig } from "../services/CharacterFs.js"
import { extractJson, parseOr } from "./parse.js"
import { ModelService } from "../services/ModelService.js"
import { SpawnError, ReadinessError } from "../services/model-backend.js"

export { extractJson, parseOr }

const SKILLS_DIR = path.resolve(import.meta.dirname, "../skills")
const skills = {
  observe: loadSkillSync(path.join(SKILLS_DIR, "observe.md")),
  orient: loadSkillSync(path.join(SKILLS_DIR, "orient.md")),
  decide: loadSkillSync(path.join(SKILLS_DIR, "decide.md")),
  evaluate: loadSkillSync(path.join(SKILLS_DIR, "evaluate.md")),
}

export interface CortexRunnerConfig {
  char: CharacterConfig
  cadence: Cadence
  models: CortexModelConfig
  /** The character's emotional palette (emoji pole-pairs). Defaults to TEMPLATE_PALETTE. */
  palette?: string
}

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

/** Run one prompt against the model backing `tier`, returning the raw text. */
const callTier = (config: CortexRunnerConfig, tier: "hindbrain" | "forebrain" | "conscious", prompt: string) =>
  Effect.gen(function* () {
    const svc = yield* ModelService
    const client = yield* ModelClient
    const handle = resolveHandle(config.models, tier)
    const res = yield* svc.withTier(tier)(
      client.complete(handle, [{ role: "user", content: prompt }]),
    )
    return res.text
  })

// ── Hindbrain (observe) ──────────────────────────────────────
export function runHindbrain(
  config: CortexRunnerConfig,
  events: string[],
  waitState: WaitState | null,
): Effect.Effect<ObserveResult, ModelError | SpawnError | ReadinessError, ModelClient | ModelService> {
  const prompt = skills.observe.render({
    cadence: config.cadence,
    cadenceGuidance: getCadenceGuidance("observe", config.cadence),
    events: events.map((e, i) => `[Event ${i + 1}] ${e}`).join("\n\n"),
    waitState: waitState
      ? `Waiting for: ${waitState.waitingFor}\nResolution signal: ${waitState.resolutionSignal}\nDisposition: ${waitState.disposition}`
      : "None — not currently waiting.",
    palette: config.palette ?? TEMPLATE_PALETTE,
  })
  return callTier(config, "hindbrain", prompt).pipe(
    Effect.map((text) =>
      parseOr<ObserveResult>(text, {
        disposition: "accumulate",
        emotionalWeight: "😐",
        reason: "parse failure — defaulting to accumulate",
      }),
    ),
  )
}

// ── Forebrain (orient) ───────────────────────────────────────
export function runForebrain(
  config: CortexRunnerConfig,
  accumulatedEvents: string[],
  domainState: string,
  identity: { background: string; values: string; diary: string },
  emotionalWeight: string,
): Effect.Effect<OrientResult, ModelError | SpawnError | ReadinessError, ModelClient | ModelService> {
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
  return callTier(config, "forebrain", prompt).pipe(
    Effect.map((text) =>
      parseOr<OrientResult>(text, {
        headline: "Orient parse failure — situation unknown",
        sections: [],
        whatChanged: "Unknown — forebrain could not parse",
        emotionalState: emotionalWeight,
        metrics: {},
      }),
    ),
  )
}

// ── Conscious (decide) ───────────────────────────────────────
export function runConsciousDecide(
  config: CortexRunnerConfig,
  orient: OrientResult,
  currentPlanState: string,
  availableActions: string,
): Effect.Effect<DecideResult, ModelError | SpawnError | ReadinessError, ModelClient | ModelService> {
  const prompt = skills.decide.render({
    cadence: config.cadence,
    cadenceGuidance: getCadenceGuidance("decide", config.cadence),
    headline: orient.headline,
    whatChanged: orient.whatChanged,
    emotionalState: orient.emotionalState,
    sections: orient.sections.map((s) => `#### ${s.heading}\n${s.body}`).join("\n\n"),
    metrics: JSON.stringify(orient.metrics, null, 2),
    currentPlanState,
    availableSkills: availableActions,
  })
  return callTier(config, "conscious", prompt).pipe(
    Effect.map((text) =>
      parseOr<DecideResult>(text, { decision: "continue", reasoning: "parse failure — defaulting to continue" }),
    ),
  )
}

// ── Conscious (evaluate) ─────────────────────────────────────
export function runConsciousEvaluate(
  config: CortexRunnerConfig,
  input: EvaluateInput,
): Effect.Effect<EvaluateResult, ModelError | SpawnError | ReadinessError, ModelClient | ModelService> {
  const secondsBudgeted = input.ticksBudgeted * 30
  const secondsConsumed = input.ticksConsumed * 30
  const overrunWarning =
    input.ticksConsumed > input.ticksBudgeted
      ? `\n\n**OVERRUN:** consumed ${input.ticksConsumed} ticks against a ${input.ticksBudgeted}-tick budget`
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
  return callTier(config, "conscious", prompt).pipe(
    Effect.map((text) =>
      parseOr<EvaluateResult>(text, {
        judgment: "partially_succeeded",
        reasoning: "parse failure — cannot determine outcome",
        transition: { transition: "next_step" },
      }),
    ),
  )
}
