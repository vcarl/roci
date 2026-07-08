import * as path from "node:path"
import { Effect } from "effect"
import type { ModelError } from "../../model/errors.js"
import type { ModelClient } from "../../model/client.js"
import type { ModelService } from "../../services/ModelService.js"
import type { SpawnError, ReadinessError } from "../../services/model-backend.js"
import { loadSkillSync } from "../../skills/loader.js"
import { getCadenceGuidance } from "#brain/limbic/autonomic/cadence.js"
import { TEMPLATE_PALETTE } from "../../core/palette.js"
import { TEMPLATE_DRIVES, parseDriveNames } from "#brain/limbic/autonomic/drives.js"
import { appraise } from "#brain/loop/state.js"
import type { ObserveResult, OrientResult, WaitState } from "../../skills/types.js"
import { parseOr, tryParseJson, isPlainObject } from "#brain/loop/parse.js"
import { logToConsole, type CharacterLog } from "../../logging/log-writer.js"
import type { EpisodeAttribution } from "../../logging/episodes.js"
import { callTier, emitTier, type CortexRunnerConfig } from "#brain/loop/tier-config.js"

const SKILLS_DIR = path.resolve(import.meta.dirname, "prompts")
const skills = {
  observe: loadSkillSync(path.join(SKILLS_DIR, "observe.md")),
  orient: loadSkillSync(path.join(SKILLS_DIR, "orient.md")),
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
  identity: { background: string; values: string; diary: string; synthesis: string },
  emotionalWeight: string,
  recalledMemories = "",
  workingMemory = "",
  /**
   * Which orient this is (spec §3, discriminator): the idle path produces a
   * plan; the in-session steer path produces a directive, not a plan. Both run
   * through this same tap, so the tier record needs this to tell them apart.
   * Defaults to "plan" (the idle path) — the steer call site passes "steer".
   */
  orientKind: "plan" | "steer" = "plan",
  /**
   * Fork-time attribution capture (Task 1 mechanism; consumed once orient runs
   * off the main fiber). When absent (the in-session path), emitTier reads the
   * live module-level episode context unchanged.
   */
  attribution?: EpisodeAttribution,
): Effect.Effect<OrientResult, ModelError | SpawnError | ReadinessError, ModelClient | ModelService | CharacterLog> {
  const prompt = skills.orient.render({
    cadence: config.cadence,
    cadenceGuidance: getCadenceGuidance("orient", config.cadence),
    accumulatedEvents: accumulatedEvents.join("\n\n"),
    domainState,
    background: identity.background,
    values: identity.values,
    diary: identity.diary,
    synthesis: identity.synthesis,
    emotionalWeight,
    recalledMemories,
    workingMemory,
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
    Effect.tap((result) => emitTier(config.char.name, "orient", prompt, result, orientKind, attribution)),
  )
}
