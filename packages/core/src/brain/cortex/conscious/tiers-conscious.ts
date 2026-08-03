import * as path from "node:path"
import { Effect } from "effect"
import type { ModelError } from "../../../model/errors.js"
import type { ModelClient } from "../../../model/client.js"
import type { ModelService } from "../../../services/ModelService.js"
import type { SpawnError, ReadinessError } from "../../../services/model-backend.js"
import type { CharacterLog } from "../../../logging/log-writer.js"
import type { EpisodeAttribution } from "../../../logging/episodes.js"
import { loadSkillSync } from "../../../skills/loader.js"
import { sanitizeDecideSkill, renderDomainStateForPrompt } from "#brain/stem/state.js"
import { parseOr, isPlainObject } from "#brain/stem/parse.js"
import type { DecideResult, EvaluateResult, EvaluateTransition, OrientResult } from "../../../skills/types.js"
import { callTier, emitTier, getCadenceGuidance, renderAxisBlock, type ActivationRunnerConfig } from "#brain/stem/tier-config.js"
import { sanitizeSalienceVector } from "../../../core/salience.js"

const SKILLS_DIR = path.resolve(import.meta.dirname, "prompts")
const skills = {
  decide: loadSkillSync(path.join(SKILLS_DIR, "decide.md")),
  evaluate: loadSkillSync(path.join(SKILLS_DIR, "evaluate.md")),
  diary: loadSkillSync(path.join(SKILLS_DIR, "diary.md")),
}

export interface EvaluateInput {
  task: string
  goal: string
  successCondition: string
  ticksBudgeted: number
  ticksConsumed: number
  executionReport: string
  /**
   * The mechanical `## Tool Calls This Step` trace (rendered by
   * {@link ./tool-trace.ts#renderToolTrace}). Session-filled; optional so
   * standalone callers/tests may omit it — the renderer supplies the empty
   * placeholder when it is absent/blank.
   */
  toolTrace?: string
  stateDiff: string
  conditionCheck: string
  emotionalState: string
  remainingSteps: string
  recalledMemories?: string
}

export interface DiaryTurnInput {
  charName: string
  task: string
  goal: string
  judgment: string
  reasoning: string
  executionReport: string
  emotionalState: string
}

// ── Conscious (decide) ───────────────────────────────────────
export function runConsciousDecide(
  config: ActivationRunnerConfig,
  orient: OrientResult,
  currentPlanState: string,
  availableActions: string,
  recalledMemories = "",
  workingMemory = "",
  skillIndex = "",
  /** Fork-time attribution capture (see runForebrain); absent on the in-session path. */
  attribution?: EpisodeAttribution,
  /**
   * D2: the live domain snapshot (`summaryJson`) the orient ran over. Rendered as
   * an authoritative "ground truth, live" section so the decider grounds its
   * choice in the observed world rather than the synthesis's (occasionally
   * confabulated) narrative. Empty string ⇒ the section is omitted.
   */
  domainState = "",
): Effect.Effect<DecideResult, ModelError | SpawnError | ReadinessError, ModelClient | ModelService | CharacterLog> {
  const prompt = skills.decide.render({
    cadence: config.cadence,
    cadenceGuidance: getCadenceGuidance("decide", config.cadence),
    domainState: domainState.trim() ? renderDomainStateForPrompt(domainState) : "_No live domain snapshot available._",
    headline: orient.headline,
    whatChanged: orient.whatChanged,
    emotionalState: orient.emotionalState,
    confidence: orient.confidence,
    // Defensive: a malformed OrientResult (non-array/absent `sections`) must
    // never crash the decide builder. runForebrain normalizes this, but guard
    // here too in case an orient result is constructed elsewhere.
    sections: (Array.isArray(orient.sections) ? orient.sections : [])
      .map((s) => `#### ${s.heading}\n${s.body}`)
      .join("\n\n"),
    metrics: JSON.stringify(orient.metrics, null, 2),
    currentPlanState,
    availableSkills: availableActions,
    recalledMemories,
    workingMemory,
    skillIndex,
    // The salience axes this decision is scored across (design §3, stage C).
    // Same formatter every producing tier uses — see renderAxisBlock.
    axes: renderAxisBlock(config.axes),
  })
  return callTier(config, "conscious", "decide", prompt).pipe(
    Effect.map((text) => {
      const parsed = sanitizeDecideSkill(
        parseOr<DecideResult>(text, { decision: "continue", reasoning: "parse failure — defaulting to continue" }),
      )
      // The C vector through the same mechanical clamp every other tier's goes
      // through. NOTE the parse-miss fallback above carries no `salience`, and
      // must not: a decide that failed to parse produced no reading, and `{}`
      // would claim it read neutral on every axis.
      if (!config.axes) return parsed
      return { ...parsed, salience: sanitizeSalienceVector((parsed as { salience?: unknown }).salience, config.axes) }
    }),
    Effect.tap((result) => emitTier(config.char, "decide", prompt, result, undefined, attribution)),
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
  config: ActivationRunnerConfig,
  input: EvaluateInput,
): Effect.Effect<EvaluateResult, ModelError | SpawnError | ReadinessError, ModelClient | ModelService | CharacterLog> {
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
    toolTrace: input.toolTrace?.trim() ? input.toolTrace : "_No tool calls recorded this step._",
    stateDiff: input.stateDiff,
    conditionCheck: input.conditionCheck,
    emotionalState: input.emotionalState,
    remainingSteps: input.remainingSteps,
    recalledMemories: input.recalledMemories ?? "",
    // The salience axes this outcome is scored across (design §3, stage C).
    // Same formatter every producing tier uses — see renderAxisBlock.
    axes: renderAxisBlock(config.axes),
  })
  return callTier(config, "conscious", "evaluate", prompt).pipe(
    Effect.map((text) => {
      const result = parseOr<EvaluateResult>(text, {
        judgment: "partially_succeeded",
        reasoning: "parse failure — cannot determine outcome",
        transition: { transition: "next_step" },
      })
      // Normalize `transition` at the parse boundary so the loop's
      // `evalResult.transition.transition` reads are always against a valid
      // object — a bare-string or wrong-typed transition is coerced here.
      const normalized = { ...result, transition: normalizeTransition(result.transition) }
      // The C vector through the same mechanical clamp every other tier's goes
      // through. Absent vocabulary ⇒ no field, matching the other three tiers.
      if (!config.axes) return normalized
      return {
        ...normalized,
        salience: sanitizeSalienceVector((result as { salience?: unknown }).salience, config.axes),
      }
    }),
    Effect.tap((result) => emitTier(config.char, "evaluate", prompt, result)),
  )
}

// ── Forebrain (diary) ────────────────────────────────────────
/**
 * Dedicated journal turn — runs after evaluate and always produces a short
 * first-person reflection on the step just completed. Replaces the old optional
 * `diaryEntry` field the small conscious model reliably omitted. Returns plain
 * (trimmed) prose; the caller appends it to the diary. The forebrain runs with
 * enable_thinking:false (handles.ts), so there is no `<think>` preamble to strip.
 */
export function runDiaryTurn(
  config: ActivationRunnerConfig,
  input: DiaryTurnInput,
): Effect.Effect<string, ModelError | SpawnError | ReadinessError, ModelClient | ModelService | CharacterLog> {
  const prompt = skills.diary.render({
    charName: input.charName,
    task: input.task,
    goal: input.goal,
    judgment: input.judgment,
    reasoning: input.reasoning,
    executionReport: input.executionReport,
    emotionalState: input.emotionalState,
  })
  return callTier(config, "forebrain", "diary", prompt).pipe(
    Effect.map((text) => text.trim()),
    Effect.tap((entry) => emitTier(config.char, "diary", prompt, entry)),
  )
}
