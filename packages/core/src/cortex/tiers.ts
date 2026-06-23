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
  EvaluateTransition,
  WaitState,
} from "../skills/types.js"
import type { CharacterConfig } from "../services/CharacterFs.js"
import { extractJson, parseOr, tryParseJson, isPlainObject } from "./parse.js"
import { ModelService } from "../services/ModelService.js"
import { SpawnError, ReadinessError } from "../services/model-backend.js"
import { CharacterLog, logToConsole } from "../logging/log-writer.js"

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

/** Max length of raw forebrain text echoed to the log on a parse failure. */
const RAW_FOREBRAIN_LOG_LIMIT = 2000

/**
 * Safe defaults for every required OrientResult field. Used both as the
 * parse-miss fallback AND as the merge-base for a successful-but-incomplete
 * parse, so the returned OrientResult always has well-formed fields. `headline`
 * is overwritten with a parse-failure marker on the miss path.
 */
const orientFallback = (emotionalWeight: string): OrientResult => ({
  headline: "Orient parse failure — situation unknown",
  sections: [],
  whatChanged: "Unknown — forebrain could not parse",
  emotionalState: emotionalWeight,
  metrics: {},
})

// ── Forebrain (orient) ───────────────────────────────────────
export function runForebrain(
  config: CortexRunnerConfig,
  accumulatedEvents: string[],
  domainState: string,
  identity: { background: string; values: string; diary: string },
  emotionalWeight: string,
): Effect.Effect<OrientResult, ModelError | SpawnError | ReadinessError, ModelClient | ModelService | CharacterLog> {
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
  const fallback = orientFallback(emotionalWeight)
  return callTier(config, "forebrain", prompt).pipe(
    Effect.flatMap((text) => {
      const parsed = tryParseJson<OrientResult>(text)
      if (parsed.ok && isPlainObject(parsed.value)) {
        // Merge over the fallback so any field the model omitted is filled with
        // a safe default — the tolerant extractor now recovers parseable-but-
        // incomplete objects the old brittle parser rejected. The isPlainObject
        // guard keeps a non-object parse (array/string/number) off the merge
        // path (it would otherwise pollute the result with index keys); such a
        // parse falls through to the parse-miss fallback below. Then coerce
        // `sections` to an array even if the model emitted a wrong type
        // (string/null), since downstream `.map`s it.
        const merged = { ...fallback, ...parsed.value }
        return Effect.succeed<OrientResult>({
          ...merged,
          sections: Array.isArray(merged.sections) ? merged.sections : [],
        })
      }
      // Parse miss: log the raw forebrain output so the failure is diagnosable
      // (previously silent). Truncate to keep the log line sane. Only fires on
      // failure — the success path above never logs.
      const truncated =
        text.length > RAW_FOREBRAIN_LOG_LIMIT
          ? `${text.slice(0, RAW_FOREBRAIN_LOG_LIMIT)}… [truncated ${text.length - RAW_FOREBRAIN_LOG_LIMIT} chars]`
          : text
      return logToConsole(
        config.char.name,
        "cortex",
        `tier=forebrain step=orient parse failure; raw output: ${truncated}`,
      ).pipe(
        // A log-write failure must never crash the loop — swallow it.
        Effect.catchAll(() => Effect.void),
        Effect.as<OrientResult>(fallback),
      )
    }),
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
    // Defensive: a malformed OrientResult (non-array/absent `sections`) must
    // never crash the decide builder. runForebrain normalizes this, but guard
    // here too in case an orient result is constructed elsewhere.
    sections: (Array.isArray(orient.sections) ? orient.sections : [])
      .map((s) => `#### ${s.heading}\n${s.body}`)
      .join("\n\n"),
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

/** The transition enum values the loop branches on. */
const TRANSITION_VALUES = ["next_step", "replan", "wait", "terminate"] as const
type TransitionName = (typeof TRANSITION_VALUES)[number]
const isTransitionName = (v: unknown): v is TransitionName =>
  typeof v === "string" && (TRANSITION_VALUES as readonly string[]).includes(v)

/**
 * Coerce an EvaluateResult's `transition` into the always-valid object shape the
 * loop reads as `evalResult.transition.transition`. A small model can emit:
 *  - a bare enum string (`"transition":"replan"`) → wrap as `{transition:"replan"}`
 *  - a missing / wrong-typed transition → default to the safe `{transition:"next_step"}`
 *  - a proper object but with a non-enum `transition` field → default to next_step
 * `wait`/`replan`/`terminate` carry extra fields; a bare-string coercion supplies
 * only the enum. The loop's branches read those extras defensively (`t.wait`,
 * `t.summary`), and `next_step` is the safe no-extra-data transition, so an
 * unrecoverable shape degrades to advancing the step rather than misbehaving.
 */
function normalizeTransition(raw: EvaluateResult["transition"]): EvaluateTransition {
  if (isTransitionName(raw)) {
    return { transition: raw } as EvaluateTransition
  }
  if (isPlainObject(raw) && isTransitionName((raw as { transition?: unknown }).transition)) {
    return raw as EvaluateTransition
  }
  return { transition: "next_step" }
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
    Effect.map((text) => {
      const result = parseOr<EvaluateResult>(text, {
        judgment: "partially_succeeded",
        reasoning: "parse failure — cannot determine outcome",
        transition: { transition: "next_step" },
      })
      // Normalize `transition` at the parse boundary so the loop's
      // `evalResult.transition.transition` reads are always against a valid
      // object — a bare-string or wrong-typed transition is coerced here.
      return { ...result, transition: normalizeTransition(result.transition) }
    }),
  )
}
