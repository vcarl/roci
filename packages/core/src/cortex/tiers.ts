import * as path from "node:path"
import { Cause, Effect } from "effect"
import { ModelClient } from "../model/client.js"
import type { ModelError } from "../model/errors.js"
import { resolveHandle, type CortexModelConfig } from "../model/handles.js"
import { loadSkillSync } from "../skills/loader.js"
import { getCadenceGuidance, type Cadence } from "../skills/cadence.js"
import { TEMPLATE_PALETTE } from "../core/palette.js"
import { TEMPLATE_DRIVES, parseDriveNames } from "../core/drives.js"
import { appraise } from "./state.js"
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
import { CharacterLog, logToConsole, logExchange, logBehavior } from "../logging/log-writer.js"
import { appendTransitionEpisode, episodeContext } from "../logging/episodes.js"

export { extractJson, parseOr }

const SKILLS_DIR = path.resolve(import.meta.dirname, "../skills")
const skills = {
  observe: loadSkillSync(path.join(SKILLS_DIR, "observe.md")),
  orient: loadSkillSync(path.join(SKILLS_DIR, "orient.md")),
  decide: loadSkillSync(path.join(SKILLS_DIR, "decide.md")),
  evaluate: loadSkillSync(path.join(SKILLS_DIR, "evaluate.md")),
  diary: loadSkillSync(path.join(SKILLS_DIR, "diary.md")),
}

export interface CortexRunnerConfig {
  char: CharacterConfig
  cadence: Cadence
  models: CortexModelConfig
  /** The character's emotional palette (emoji pole-pairs). Defaults to TEMPLATE_PALETTE. */
  palette?: string
  /** The character's innate drives block (core + domain). Defaults to TEMPLATE_DRIVES.
   *  Threaded into the per-event observe prompt as the appraisal reference frame. */
  drives?: string
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

/** Map a tier-call failure to a tier_call outcome. Pure. */
export function classifyTierOutcome(error: unknown): "error" | "timeout" {
  if (error instanceof ReadinessError && error.timedOut) return "timeout"
  const tag = (error as { _tag?: string })?._tag
  if (tag === "TimeoutException" || (tag === "ReadinessError" && (error as ReadinessError).timedOut)) return "timeout"
  return "error"
}

/** Run one prompt against the model backing `tier`, log the full exchange, return the raw text. */
const callTier = (
  config: CortexRunnerConfig,
  tier: "hindbrain" | "forebrain" | "conscious",
  step: "observe" | "orient" | "decide" | "evaluate" | "diary",
  prompt: string,
) =>
  Effect.gen(function* () {
    const svc = yield* ModelService
    const client = yield* ModelClient
    const handle = resolveHandle(config.models, tier)
    const startedAt = Date.now()
    const res = yield* svc
      .withTier(tier)(client.complete(handle, [{ role: "user", content: prompt }]))
      .pipe(
        Effect.tapErrorCause((cause) =>
          logBehavior(config.char.name, "cortex", "tier_call", {
            type: "tier_call",
            tier,
            latencyMs: Date.now() - startedAt,
            // Cause.squash extracts the underlying error (ReadinessError / TimeoutException)
            // from the failure Cause so classifyTierOutcome can inspect it. Do NOT use a
            // `.squash` property access — squash is a function, not a field.
            outcome: classifyTierOutcome(Cause.squash(cause)),
          }),
        ),
      )
    yield* logBehavior(config.char.name, "cortex", "tier_call", {
      type: "tier_call",
      tier,
      latencyMs: Date.now() - startedAt,
      outcome: "ok",
    })
    // Full prompt+response archive (debug level; jsonl-complete). Never crash the loop.
    yield* logExchange(config.char.name, "cortex", step, prompt, res.text, {
      tier,
      model: handle.model,
      usage: res.usage,
    }).pipe(Effect.catchAll(() => Effect.void))
    return res.text
  })

/**
 * Full-fidelity transition record for one OODA tier call (spec §1): the rendered
 * prompt and the PARSED output. Observe is excluded (per-event, high cadence).
 * Never fails; never disturbs the tier call.
 */
const emitTier = (
  character: string,
  phase: "orient" | "decide" | "evaluate" | "diary",
  prompt: string,
  output: unknown,
): Effect.Effect<void> => {
  const ctx = episodeContext(character)
  return appendTransitionEpisode(character, {
    type: "tier",
    ts: new Date().toISOString(),
    tick: ctx.tick,
    stepId: ctx.stepId,
    phase,
    prompt,
    output,
  })
}

// ── Hindbrain (observe) ──────────────────────────────────────
/**
 * Appraise ONE state-changing event (per-event processing, §3.1). Renders the
 * single-event observe prompt (the validated v3.2 prompt: drives + palette as
 * the two reference frames, both-pole few-shot, interrupt criterion separated
 * from the weight scale), calls the 2B hindbrain at temp 0.05, and returns a
 * validated/clamped `ObserveResult` for that event. The parse-miss fallback is a
 * single object (the parser's happy path); `appraise` then clamps `weight` to
 * 0–5 and validates `drive` against the closed vocabulary parsed from the drive
 * block. Inert (no-`stateUpdate`) events are tagged deterministically by the
 * loop's fast-path and never reach this function.
 */
export function runHindbrain(
  config: CortexRunnerConfig,
  event: string,
  waitState: WaitState | null,
): Effect.Effect<ObserveResult, ModelError | SpawnError | ReadinessError, ModelClient | ModelService | CharacterLog> {
  const drives = config.drives ?? TEMPLATE_DRIVES
  const prompt = skills.observe.render({
    event,
    waitState: waitState
      ? `Waiting for: ${waitState.waitingFor}\nResolution signal: ${waitState.resolutionSignal}\nDisposition: ${waitState.disposition}`
      : "None — not currently waiting.",
    palette: config.palette ?? TEMPLATE_PALETTE,
    drives,
  })
  const knownDrives = parseDriveNames(drives)
  return callTier(config, "hindbrain", "observe", prompt).pipe(
    Effect.map((text) =>
      appraise(
        parseOr<Partial<ObserveResult>>(text, {
          disposition: "accumulate",
          emotionalWeight: "😐",
          drive: null,
          weight: 0,
          reason: "parse failure — defaulting to accumulate",
        }),
        knownDrives,
      ),
    ),
  )
}

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
  confidence: "low",
  metrics: {},
})

// ── Forebrain (orient) ───────────────────────────────────────
export function runForebrain(
  config: CortexRunnerConfig,
  accumulatedEvents: string[],
  domainState: string,
  identity: { background: string; values: string; diary: string },
  emotionalWeight: string,
  recalledMemories = "",
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
    recalledMemories,
  })
  const fallback = orientFallback(emotionalWeight)
  return callTier(config, "forebrain", "orient", prompt).pipe(
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
      // Parse miss: log the FULL raw forebrain output so the failure is fully
      // diagnosable. The console truncates long lines for display; events.jsonl
      // keeps the complete text. Only fires on failure — the success path never logs here.
      return logToConsole(
        config.char.name,
        "cortex",
        `tier=forebrain step=orient parse failure; raw output: ${text}`,
        "warn",
      ).pipe(
        // A log-write failure must never crash the loop — swallow it.
        Effect.catchAll(() => Effect.void),
        Effect.as<OrientResult>(fallback),
      )
    }),
    Effect.tap((result) => emitTier(config.char.name, "orient", prompt, result)),
  )
}

// ── Conscious (decide) ───────────────────────────────────────
export function runConsciousDecide(
  config: CortexRunnerConfig,
  orient: OrientResult,
  currentPlanState: string,
  availableActions: string,
  recalledMemories = "",
): Effect.Effect<DecideResult, ModelError | SpawnError | ReadinessError, ModelClient | ModelService | CharacterLog> {
  const prompt = skills.decide.render({
    cadence: config.cadence,
    cadenceGuidance: getCadenceGuidance("decide", config.cadence),
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
  })
  return callTier(config, "conscious", "decide", prompt).pipe(
    Effect.map((text) =>
      parseOr<DecideResult>(text, { decision: "continue", reasoning: "parse failure — defaulting to continue" }),
    ),
    Effect.tap((result) => emitTier(config.char.name, "decide", prompt, result)),
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
    stateDiff: input.stateDiff,
    conditionCheck: input.conditionCheck,
    emotionalState: input.emotionalState,
    remainingSteps: input.remainingSteps,
    recalledMemories: input.recalledMemories ?? "",
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
      return { ...result, transition: normalizeTransition(result.transition) }
    }),
    Effect.tap((result) => emitTier(config.char.name, "evaluate", prompt, result)),
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
  config: CortexRunnerConfig,
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
    Effect.tap((entry) => emitTier(config.char.name, "diary", prompt, entry)),
  )
}
