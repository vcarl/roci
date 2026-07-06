import { Cause, Effect } from "effect"
import { ModelClient } from "../../model/client.js"
import { resolveHandle, type CortexModelConfig } from "../../model/handles.js"
import type { Cadence } from "../limbic/autonomic/cadence.js"
export { getCadenceGuidance } from "../limbic/autonomic/cadence.js"
export type { Cadence } from "../limbic/autonomic/cadence.js"
import type { CharacterConfig } from "../../services/CharacterFs.js"
import { ModelService } from "../../services/ModelService.js"
import { ReadinessError } from "../../services/model-backend.js"
import { logExchange, logBehavior } from "../../logging/log-writer.js"
import {
  appendTransitionEpisode,
  currentEpisodeEpoch,
  episodeContext,
  type EpisodeAttribution,
} from "../../logging/episodes.js"

/**
 * Shared OODA tier-runner config + tier-calling plumbing. Loop-owned (this
 * module lives under brain/loop/) so both the limbic runners
 * (hindbrain/forebrain — brain/limbic/tiers-limbic.ts) and the
 * cortex/conscious runners (decide/evaluate/diary —
 * brain/cortex/conscious/tiers-conscious.ts) can import it DOWN without
 * either runner file importing the other.
 */
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

/** Map a tier-call failure to a tier_call outcome. Pure. */
export function classifyTierOutcome(error: unknown): "error" | "timeout" {
  if (error instanceof ReadinessError && error.timedOut) return "timeout"
  const tag = (error as { _tag?: string })?._tag
  if (tag === "TimeoutException" || (tag === "ReadinessError" && (error as ReadinessError).timedOut)) return "timeout"
  return "error"
}

/** Run one prompt against the model backing `tier`, log the full exchange, return the raw text. */
export const callTier = (
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
export const emitTier = (
  character: string,
  phase: "orient" | "decide" | "evaluate" | "diary",
  prompt: string,
  output: unknown,
  orientKind?: "plan" | "steer",
  attribution?: EpisodeAttribution,
): Effect.Effect<void> => {
  const ctx = attribution ?? episodeContext(character)
  const epoch = attribution ? attribution.epoch : currentEpisodeEpoch(character)
  return appendTransitionEpisode(character, {
    type: "tier",
    ts: new Date().toISOString(),
    tick: ctx.tick,
    stepId: ctx.stepId,
    phase,
    // Only stamp orientKind on orient records — decide/evaluate/diary never set it.
    ...(phase === "orient" && orientKind ? { orientKind } : {}),
    // Run-epoch stamp (scan-invariant carrier — see TierTransitionEpisode.epoch).
    // Absent outside a cortex run (no epoch begun).
    ...(epoch !== null ? { epoch } : {}),
    prompt,
    output,
  })
}
