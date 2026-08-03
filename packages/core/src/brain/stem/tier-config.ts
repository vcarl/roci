import { Cause, Effect } from "effect"
import { ModelClient } from "../../model/client.js"
import { resolveHandle, type CortexModelConfig } from "../../model/handles.js"
import type { AxisSpec } from "../../core/salience.js"
import type { Cadence } from "#brain/limbic/hypothalamus/cadence.js"
export { getCadenceGuidance } from "#brain/limbic/hypothalamus/cadence.js"
export type { Cadence } from "#brain/limbic/hypothalamus/cadence.js"
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
 * module lives under brain/stem/) so both the limbic runners
 * (hindbrain/forebrain — brain/limbic/tiers-limbic.ts) and the
 * cortex/conscious runners (decide/evaluate/diary —
 * brain/cortex/conscious/tiers-conscious.ts) can import it DOWN without
 * either runner file importing the other.
 */
export interface ActivationRunnerConfig {
  char: CharacterConfig
  cadence: Cadence
  models: CortexModelConfig
  /** The character's emotional palette (emoji pole-pairs). Defaults to TEMPLATE_PALETTE. */
  palette?: string
  /** The character's innate drives block (core + domain). Defaults to TEMPLATE_DRIVES.
   *  Threaded into the per-event observe prompt as the appraisal reference frame. */
  drives?: string
  /**
   * The character's derived salience axes (design 2026-07-31 §1), in order:
   * core drives, domain drives, then one bipolar axis per PALETTE.md pole pair.
   * Every tier that produces a C vector (§3) shows this list to the model and
   * sanitizes the answer against it.
   *
   * ABSENT means the vocabulary could not be derived. That is not an error and
   * must never be treated as one here: consumers ask for no vector and sanitize
   * to `{}`, the memory CLI still computes A at insert, and the adjudicator
   * still supersedes. A tick must never fail over a malformed PALETTE.md.
   */
  axes?: ReadonlyArray<AxisSpec>
}

/**
 * Render the axis list for a prompt's `{{axes}}` slot. ONE formatter for all
 * four producing tiers (observe / orient / decide / evaluate): four prompts
 * describing the same vocabulary in four slightly different ways is how a
 * cross-tier scoring rubric drifts, and the adjudicator exists precisely because
 * per-tier rubrics already drift enough.
 *
 * Each line carries the axis name EXACTLY as it must be keyed, plus its range —
 * and for a bipolar palette axis, which pole each end is. The sign convention is
 * recoverable from the name alone (first pole negative), and the line says so
 * again anyway, because a model reading `burdened-exhilarated: -0.7` at
 * generation time has no other place to look.
 */
export function renderAxisBlock(axes?: ReadonlyArray<AxisSpec>): string {
  if (!axes || axes.length === 0) return "(none) — omit the salience field entirely"
  return axes
    .map((a) =>
      a.polarity === "bipolar"
        ? `- ${a.name}: -1.0 (hard toward "${a.negativeGloss}") through 0.0 (neutral middle) to +1.0 (hard toward "${a.positiveGloss}")`
        : `- ${a.name}: 0.0 to 1.0 (bears on it hard) — ${a.positiveGloss}`,
    )
    .join("\n")
}

/**
 * Was a model completion cut off at its token ceiling? True when the reported
 * completion-token count reached (or passed) `maxTokens`, or when the provider
 * explicitly signalled a length stop (`finish_reason: "length"`). Either signal
 * means the response is likely partial — the prime cause of downstream JSON
 * parse failures on orient — so it is flagged on the exchange record. Pure.
 */
export function isResponseTruncated(
  usage: { completionTokens?: number } | undefined,
  maxTokens: number | undefined,
  finishReason: string | undefined,
): boolean {
  if (finishReason === "length") return true
  const completion = usage?.completionTokens
  return (
    typeof completion === "number" &&
    typeof maxTokens === "number" &&
    maxTokens > 0 &&
    completion >= maxTokens
  )
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
  config: ActivationRunnerConfig,
  tier: "hindbrain" | "forebrain" | "conscious",
  // `adjudicate` is the B stage of the salience pipeline (design 2026-07-31 §3).
  // It is not an OODA step, but it IS a tier call, and routing it through here is
  // what puts it on the exchange stream alongside every other one.
  step: "observe" | "orient" | "decide" | "evaluate" | "diary" | "adjudicate",
  prompt: string,
) =>
  Effect.gen(function* () {
    const svc = yield* ModelService
    const client = yield* ModelClient
    const handle = resolveHandle(config.models, tier)
    const startedAt = Date.now()
    // Announce the call is starting BEFORE we block on the model. Without this, a
    // long in-flight generation (a multi-minute conscious `decide`) emits nothing
    // until it lands — indistinguishable from an idle or a hung loop. The completion
    // `tier_call` below is unchanged; this is its in-flight counterpart.
    yield* logBehavior(config.char.name, "cortex", "tier_call", {
      type: "tier_call_start",
      tier,
      step,
    })
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
    // `truncated` flags a completion cut off at maxTokens (a partial response that
    // silently breaks JSON parsing); `finishReason` records the provider's stop reason.
    const maxTokens = handle.params?.maxTokens
    const truncated = isResponseTruncated(res.usage, maxTokens, res.finishReason)
    yield* logExchange(config.char.name, "cortex", step, prompt, res.text, {
      tier,
      model: handle.model,
      usage: res.usage,
      ...(res.finishReason ? { finishReason: res.finishReason } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      truncated,
    }).pipe(Effect.catchAll(() => Effect.void))
    return res.text
  })

/**
 * Full-fidelity transition record for one OODA tier call (spec §1): the rendered
 * prompt and the PARSED output. Observe is excluded (per-event, high cadence).
 * Never fails; never disturbs the tier call.
 */
export const emitTier = (
  char: CharacterConfig,
  phase: "orient" | "decide" | "evaluate" | "diary",
  prompt: string,
  output: unknown,
  orientKind?: "plan" | "steer",
  attribution?: EpisodeAttribution,
): Effect.Effect<void> => {
  const ctx = attribution ?? episodeContext(char.name)
  const epoch = attribution ? attribution.epoch : currentEpisodeEpoch(char.name)
  return appendTransitionEpisode(char, {
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
